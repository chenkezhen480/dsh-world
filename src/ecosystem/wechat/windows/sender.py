"""Send-only native transport. No UI automation and no receive hooks."""
import ctypes as c
import hashlib
import json
import re
import os
from pathlib import Path

CALLS = ('application', 'scheduler', 'schedule', 'context', 'provider', 'manager', 'text',
         'image', 'emoticon', 'copyWide', 'validateGif', 'probeGif', 'releaseProbe', 'send',
         'allocate', 'free', 'accountRoot', 'contextVtable', 'emoticonVtable')
# Only a GIF sticker needs these; a build with them unmapped (null) sends stickers as a still image instead.
STICKER_CALLS = ('emoticon', 'validateGif', 'probeGif', 'releaseProbe', 'emoticonVtable')


def sendsStickers(profile):
    return all(profile['addresses'].get(name) for name in STICKER_CALLS)


class NativeRequest(c.Structure):
    _fields_ = [(name, c.c_uint32) for name in ('size', 'pid', 'ownerPid', 'kind', 'timestamp', 'imageSize')] + [
        ('rva', c.c_uint32 * len(CALLS)), ('account', c.c_char * 128),
        ('target', c.c_char * 128), ('value', c.c_char * 4096),
        ('status', c.c_uint32), ('stage', c.c_uint32), ('exception', c.c_uint32)]


def encodeRequest(profile, pid, account, target, kind, value):
    if kind not in (0, 1, 2, 3) or type(pid) is not int or pid <= 0:
        raise ValueError('无效的原生请求')
    for identity in (account, target):
        if not isinstance(identity, str) or not re.fullmatch(r'[A-Za-z0-9_.@-]{1,127}', identity):
            raise ValueError('无效的微信账号或目标 ID')
    if not isinstance(value, str) or '\0' in value or len(value.encode('utf-8')) >= 4095 or (kind and not value):
        raise ValueError('单条内容需要 1–4094 UTF-8 字节')
    if kind == 3 and not sendsStickers(profile):
        raise ValueError(f"微信 {profile['version']} 未适配原生表情包发送")
    request = NativeRequest()
    request.size, request.pid, request.kind = c.sizeof(request), pid, kind
    request.ownerPid = os.getpid()
    request.timestamp, request.imageSize = profile['timestamp'], profile['imageSize']
    request.rva[:] = [profile['addresses'][name] or 0 for name in CALLS]
    request.account, request.target, request.value = account.encode(), target.encode(), value.encode('utf-8')
    return request


def fileDigest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verifyFile(path, size, digest):
    if Path(path).stat().st_size != size:
        raise ValueError('微信构建大小不匹配，禁止加载原生桥')
    if fileDigest(path) != digest:
        raise ValueError('文件指纹不匹配，禁止加载原生桥')


def selectProfile(path, profiles):
    size = Path(path).stat().st_size
    candidates = [profile for profile in profiles if profile['size'] == size]
    if candidates:
        digest = fileDigest(path)
        matches = [profile for profile in candidates if profile['sha256'] == digest]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise ValueError('微信构建匹配多个适配配置，禁止加载原生桥')
    versions = ' / '.join(profile['version'] for profile in profiles)
    raise ValueError(f'不支持当前微信构建，已适配版本：{versions}；文件大小与 SHA256 必须同时匹配，禁止加载原生桥')


class BuildStale(RuntimeError):
    """No build of the native bridge matches its source: `engine/build.ps1` makes one, nothing else may stand in."""


def currentBuild(engineDir):
    """The build record in `engineDir`, only if it was compiled from the bridge source shipped beside this file."""
    buildFile = Path(engineDir) / 'current.json'
    if not buildFile.is_file():
        raise BuildStale('还没有构建原生桥，请先运行 Build')
    build = json.loads(buildFile.read_text(encoding='utf-8-sig'))
    source = Path(__file__).parent / 'engine/bridge.cpp'
    if hashlib.sha256(source.read_bytes()).hexdigest() != build['sourceSha256']:
        raise BuildStale('原生桥源码已变化，请先重新 Build')
    return build


class NativeSender:
    def __init__(self, config, checkProcess):
        import psutil
        from ctypes import wintypes as w
        self.config, self.checkProcess = config, checkProcess
        self.checkProcess()
        self.process = psutil.Process(config['processId'])
        coreFiles = {m.path for m in self.process.memory_maps() if Path(m.path).name.lower() == 'weixin.dll'}
        if len(coreFiles) != 1:
            raise RuntimeError('不能唯一核对微信核心 DLL')
        core = Path(next(iter(coreFiles)))
        profiles = json.loads((Path(__file__).parent / 'engine/profiles.json').read_text(encoding='utf-8-sig'))
        self.profile = selectProfile(core, profiles)
        # The build sits beside the adapter's config.json, which is where the adapter runs from or is managed by the plugin.
        engineDir = Path(config['engineDir']) if config.get('engineDir') else Path(__file__).resolve().parents[4] / '.host/wechat/engine'
        build = currentBuild(engineDir)
        self.dll = Path(build['file']).resolve()
        verifyFile(self.dll, self.dll.stat().st_size, build['sha256'])
        self.api = c.WinDLL('kernel32', use_last_error=True)
        signatures = {
            'OpenProcess': (w.HANDLE, [w.DWORD, w.BOOL, w.DWORD]),
            'VirtualAllocEx': (c.c_void_p, [w.HANDLE, c.c_void_p, c.c_size_t, w.DWORD, w.DWORD]),
            'VirtualFreeEx': (w.BOOL, [w.HANDLE, c.c_void_p, c.c_size_t, w.DWORD]),
            'WriteProcessMemory': (w.BOOL, [w.HANDLE, c.c_void_p, c.c_void_p, c.c_size_t, c.POINTER(c.c_size_t)]),
            'ReadProcessMemory': (w.BOOL, [w.HANDLE, c.c_void_p, c.c_void_p, c.c_size_t, c.POINTER(c.c_size_t)]),
            'CreateRemoteThread': (w.HANDLE, [w.HANDLE, c.c_void_p, c.c_size_t, c.c_void_p, c.c_void_p, w.DWORD, c.c_void_p]),
            'WaitForSingleObject': (w.DWORD, [w.HANDLE, w.DWORD]),
            'GetExitCodeThread': (w.BOOL, [w.HANDLE, c.POINTER(w.DWORD)]),
            'CloseHandle': (w.BOOL, [w.HANDLE]),
            'GetModuleHandleExW': (w.BOOL, [w.DWORD, c.c_void_p, c.POINTER(w.HMODULE)]),
            'GetModuleFileNameW': (w.DWORD, [w.HMODULE, w.LPWSTR, w.DWORD]),
        }
        for name, (result, arguments) in signatures.items():
            function = getattr(self.api, name)
            function.restype, function.argtypes = result, arguments
        self.handle = self.api.OpenProcess(0x43a, False, config['processId'])
        if not self.handle:
            raise c.WinError(c.get_last_error())
        try:
            self.remoteBase = self._modules().get(str(self.dll).casefold())
            if self.remoteBase is None:
                address = c.cast(self.api.LoadLibraryW, c.c_void_p).value
                owner = w.HMODULE()
                if not self.api.GetModuleHandleExW(6, address, c.byref(owner)):
                    raise c.WinError(c.get_last_error())
                ownerPath = c.create_unicode_buffer(32768)
                if not self.api.GetModuleFileNameW(owner, ownerPath, len(ownerPath)):
                    raise c.WinError(c.get_last_error())
                module = next((base for path, base in self._modules().items() if Path(path).name.casefold() == Path(ownerPath.value).name.casefold()), None)
                if module is None:
                    raise RuntimeError('找不到目标进程的系统加载器')
                encodedPath = c.create_unicode_buffer(str(self.dll))
                self._invoke(module + address - owner.value, encodedPath, 30000)
                self.remoteBase = self._modules().get(str(self.dll).casefold())
                if self.remoteBase is None:
                    raise RuntimeError('原生桥未成功加载')
            self.local = c.WinDLL(str(self.dll))
            self.entry = self.remoteBase + c.cast(self.local.DshWechatSend, c.c_void_p).value - self.local._handle
        except Exception:
            self.close()
            raise

    def _modules(self):
        modules = {}
        for mapping in self.process.memory_maps(grouped=False):
            path = str(Path(mapping.path)).casefold()
            address = int(mapping.addr.split('-')[0], 16)
            modules[path] = min(modules.get(path, address), address)
        return modules

    def _invoke(self, entry, value, timeout):
        self.checkProcess()
        address = self.api.VirtualAllocEx(self.handle, None, c.sizeof(value), 0x3000, 4)
        if not address:
            raise c.WinError(c.get_last_error())
        thread, completed = None, False
        try:
            written = c.c_size_t()
            if not self.api.WriteProcessMemory(self.handle, address, c.byref(value), c.sizeof(value), c.byref(written)) or written.value != c.sizeof(value):
                raise c.WinError(c.get_last_error())
            thread = self.api.CreateRemoteThread(self.handle, None, 0, entry, address, 0, None)
            if not thread:
                raise c.WinError(c.get_last_error())
            if self.api.WaitForSingleObject(thread, timeout) != 0:
                raise RuntimeError('原生发送超时，结果不确定，禁止自动重发')
            completed = True
            result = c.c_ulong()
            if not self.api.GetExitCodeThread(thread, c.byref(result)):
                raise c.WinError(c.get_last_error())
            read = c.c_size_t()
            if not self.api.ReadProcessMemory(self.handle, address, c.byref(value), c.sizeof(value), c.byref(read)) or read.value != c.sizeof(value):
                raise c.WinError(c.get_last_error())
            return result.value
        finally:
            if thread:
                self.api.CloseHandle(thread)
            # A timed-out thread may still read its argument; retain that one allocation until Weixin exits.
            if completed or not thread:
                self.api.VirtualFreeEx(self.handle, address, 0, 0x8000)

    def send(self, target, kind, value=''):
        request = encodeRequest(self.profile, self.config['processId'], self.config['selfId'], target, kind, value)
        result = self._invoke(self.entry, request, 70000)
        if result or request.exception:
            raise RuntimeError(f'原生操作失败 status={result}, stage={request.stage}, exception={request.exception}；请核对后再操作')
        return dict(stage=request.stage, status=request.status)

    def close(self):
        if self.handle:
            if not self.api.CloseHandle(self.handle): raise c.WinError(c.get_last_error())
            self.handle = None
