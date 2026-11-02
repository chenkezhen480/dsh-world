// Native ABI research attribution and separate license: see NOTICE.md and LICENSE.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdint>
#include <cstring>
#include <functional>
#include <memory>
#include <algorithm>

enum Call { Application, Scheduler, Schedule, Context, Provider, Manager, Text,
    Image, Emoticon, CopyWide, ValidateGif, ProbeGif, ReleaseProbe, Send, Allocate,
    Free, AccountRoot, ContextVtable, EmoticonVtable, CallCount };
struct Request {
    uint32_t size, pid, ownerPid, kind, timestamp, imageSize;
    uint32_t rva[CallCount];
    char account[128], target[128], value[4096];
    uint32_t status, stage, exception;
};
static_assert(sizeof(Request) == 4464);
struct Shared { unsigned char* object; unsigned char* owner; };
struct String { char data[16]{}; uint64_t length = 0, capacity = 15; };
struct Wide { const wchar_t* data; uint64_t unused, length, capacity; };
struct Probe { uint8_t valid, pad[7]; unsigned char image[16]; uint32_t width, height; };
struct Job {
    Request request;
    uintptr_t base;
    HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HANDLE owner;
    volatile LONG cancelled = 0;
    ULONGLONG deadline = GetTickCount64() + 60000;
    explicit Job(const Request& input, uintptr_t address): request(input), base(address), owner(OpenProcess(SYNCHRONIZE, FALSE, input.ownerPid)) {}
    ~Job() { if (done) CloseHandle(done); if (owner) CloseHandle(owner); }
    bool expired() { return InterlockedCompareExchange(&cancelled, 0, 0) || GetTickCount64() >= deadline || !owner || WaitForSingleObject(owner, 0) != WAIT_TIMEOUT; }
    template<class F> F call(Call index) const { return reinterpret_cast<F>(base + request.rva[index]); }
    void finish(uint32_t status) { request.status = status; SetEvent(done); }
};

static void release(Shared& value) {
    auto owner = value.owner;
    value = {};
    if (!owner) return;
    auto count = reinterpret_cast<volatile LONG*>(owner + 8);
    using Destroy = void(*)(void*);
    if (InterlockedDecrement(count) == 0) {
        (*reinterpret_cast<Destroy**>(owner))[0](owner);
        if (InterlockedDecrement(count + 1) == 0) (*reinterpret_cast<Destroy**>(owner))[1](owner);
    }
}
static bool assign(Job* job, String& destination, const char* text) {
    auto length = strnlen_s(text, 4096);
    if (length >= 4095 || destination.length || destination.capacity != 15) return false;
    char* bytes = destination.data;
    if (length > 15) {
        bytes = static_cast<char*>(job->call<void*(*)(size_t)>(Allocate)(length + 1));
        if (!bytes) return false;
        memcpy(destination.data, &bytes, sizeof(bytes));
        destination.capacity = length;
    }
    memcpy(bytes, text, length + 1);
    destination.length = length;
    return true;
}
static void clear(Job* job, String& value) {
    if (value.capacity > 15) {
        void* data = *reinterpret_cast<void**>(value.data);
        auto bytes = value.capacity + 1;
        if (bytes >= 4096) { data = *(reinterpret_cast<void**>(data) - 1); bytes += 39; }
        job->call<void(*)(void*, size_t)>(Free)(data, bytes);
    }
    value = {};
}
static bool accountMatches(Job* job, const Shared& context) {
    if (!context.object || !context.owner) return false;
    auto root = *job->call<uintptr_t*>(AccountRoot);
    if (!root || *reinterpret_cast<void**>(root + 0x68) != context.object ||
        *reinterpret_cast<uintptr_t*>(context.object) != job->base + job->request.rva[ContextVtable]) return false;
    const auto& name = *reinterpret_cast<const String*>(context.object + 0x48);
    auto length = strlen(job->request.account);
    if (name.length != length || name.capacity < length || name.capacity > 1024 * 1024) return false;
    const char* data = name.capacity > 15 ? *reinterpret_cast<const char* const*>(name.data) : name.data;
    return data && memcmp(data, job->request.account, length) == 0 &&
        *job->call<uintptr_t*>(AccountRoot) == root && *reinterpret_cast<void**>(root + 0x68) == context.object;
}
struct Completion {
    volatile LONG references = 1;
    uint32_t padding = 0;
    void (*invoke)(Completion*, const unsigned char*);
    void (*destroy)(Completion*);
    std::shared_ptr<Job> job;
};
static void textCompleted(Completion* value, const unsigned char* result) {
    value->job->finish(result && result[0] == 1 ? 0 : ERROR_GEN_FAILURE);
}
static void textDestroyed(Completion* value) { delete value; }

// The SEH boundary contains no C++ objects with destructors.
static void execute(Job* job, Completion* completion) {
    Shared context{}, provider{}, manager{}, message{};
    String description{};
    struct { String receiver, body; } textRequest{};
    alignas(16) unsigned char result[128]{};
    struct { int32_t references, length; uint32_t allocation, padding; int64_t offset; wchar_t text[1024]; } qt{};
    Probe probe{};
    bool probeReady = false, textPending = false;
    uint32_t status = ERROR_GEN_FAILURE;
    __try {
        job->request.stage = 1;
        if (job->expired()) { status = ERROR_CANCELLED; __leave; }
        job->call<Shared*(*)(Shared*)>(Context)(&context);
        if (!accountMatches(job, context)) { status = ERROR_NOT_READY; __leave; }
        if (!job->request.kind) { status = 0; __leave; }
        if (job->request.kind == 1) {
            if (!assign(job, textRequest.receiver, job->request.target) ||
                !assign(job, textRequest.body, job->request.value) ||
                !assign(job, description, "dsh.wechat")) { status = ERROR_INVALID_DATA; __leave; }
            job->request.stage = 2;
            if (job->expired() || !accountMatches(job, context)) { status = ERROR_CANCELLED; __leave; }
            job->call<void(*)(void*, void*, String*, Completion**)>(Text)(nullptr, &textRequest, &description, &completion);
            textPending = true;
            status = 0;
            __leave;
        }
        job->request.stage = 3;
        int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, job->request.value, -1, qt.text, 1024);
        if (length <= 1 || GetFileAttributesW(qt.text) == INVALID_FILE_ATTRIBUTES) { status = ERROR_FILE_NOT_FOUND; __leave; }
        qt.references = -1; qt.length = length - 1; qt.offset = 24;
        if (job->request.kind == 3) {
            Wide path{qt.text, 0, static_cast<uint64_t>(qt.length), 1023};
            if (job->call<int(*)(Wide*)>(ValidateGif)(&path) != 2) { status = ERROR_NOT_SUPPORTED; __leave; }
            probeReady = true;
            job->call<Probe*(*)(Probe*, Wide*)>(ProbeGif)(&probe, &path);
            if (!probe.valid || !probe.width || !probe.height || probe.width > 1024 || probe.height > 1024) {
                status = ERROR_INVALID_DATA; __leave;
            }
            job->call<Shared*(*)(Shared*)>(Emoticon)(&message);
            if (!message.object || !message.owner || *reinterpret_cast<uintptr_t*>(message.object) != job->base + job->request.rva[EmoticonVtable]) {
                status = ERROR_INVALID_DATA; __leave;
            }
            *reinterpret_cast<uint32_t*>(message.object + 0x118) = 47;
            *reinterpret_cast<uint64_t*>(message.object + 0x778) = probe.width | (static_cast<uint64_t>(probe.height) << 32);
            job->call<void*(*)(void*, Wide*)>(CopyWide)(message.object + 0x120, &path);
        } else {
            void* path = &qt;
            job->call<Shared*(*)(void*, Shared*, void*)>(Image)(nullptr, &message, &path);
            if (!message.object || !message.owner || *reinterpret_cast<uint32_t*>(message.object + 0x118) != 3) { status = ERROR_INVALID_DATA; __leave; }
            const auto& staged = *reinterpret_cast<const String*>(message.object + 0x120);
            const wchar_t* destination = staged.capacity > 7 ? *reinterpret_cast<const wchar_t* const*>(staged.data) : reinterpret_cast<const wchar_t*>(staged.data);
            if (!staged.length || staged.length >= 1024 || staged.capacity < staged.length || !CopyFileW(qt.text, destination, TRUE)) {
                status = ERROR_WRITE_FAULT; __leave;
            }
        }
        if (!assign(job, *reinterpret_cast<String*>(message.object + 0xb0), job->request.target) || !accountMatches(job, context)) {
            status = ERROR_NOT_READY; __leave;
        }
        job->call<Shared*(*)(void*, Shared*)>(Provider)(context.object, &provider);
        if (!provider.object || !provider.owner) { status = ERROR_NOT_READY; __leave; }
        job->call<Shared*(*)(void*, Shared*)>(Manager)(provider.object, &manager);
        if (!manager.object || !manager.owner) { status = ERROR_NOT_READY; __leave; }
        job->request.stage = 4;
        if (job->expired() || !accountMatches(job, context)) { status = ERROR_CANCELLED; __leave; }
        Shared transferred = message;
        InterlockedIncrement(reinterpret_cast<volatile LONG*>(transferred.owner + 8));
        job->call<void*(*)(void*, void*, Shared*, uint8_t)>(Send)(manager.object, result, &transferred, 1);
        status = *reinterpret_cast<uint64_t*>(result) == 0 ? 0 : ERROR_GEN_FAILURE;
    } __except (EXCEPTION_EXECUTE_HANDLER) { job->request.exception = GetExceptionCode(); status = ERROR_INVALID_DATA; }
    __try {
        if (completion) textDestroyed(completion);
        clear(job, textRequest.receiver); clear(job, textRequest.body); clear(job, description);
        release(*reinterpret_cast<Shared*>(result + 40));
        clear(job, *reinterpret_cast<String*>(result + 8));
        release(message);
        if (probeReady) job->call<void(*)(void*)>(ReleaseProbe)(probe.image);
        release(manager); release(provider); release(context);
    } __except (EXCEPTION_EXECUTE_HANDLER) { job->request.exception = GetExceptionCode(); status = ERROR_INVALID_DATA; }
    if (!textPending || status) job->finish(status);
}
static uint32_t enqueue(Job* job, std::function<void()>* task) {
    Shared scheduler{}, future{};
    struct { const char* function; const char* file; uint32_t line, padding; void* caller; } location{"dshWechat", "bridge.cpp", 1, 0, nullptr};
    static_assert(sizeof(std::function<void()>) == 64);
    uint32_t status = 0;
    __try {
        void* app = job->call<void*(*)()>(Application)();
        if (!app) { status = ERROR_NOT_READY; __leave; }
        job->call<Shared*(*)(void*, Shared*)>(Scheduler)(app, &scheduler);
        if (!scheduler.object || !scheduler.owner) { status = ERROR_NOT_READY; __leave; }
        job->call<Shared*(*)(void*, Shared*, void*, std::function<void()>*, uint32_t)>(Schedule)(scheduler.object, &future, &location, task, 1);
    } __except (EXCEPTION_EXECUTE_HANDLER) { status = GetExceptionCode(); }
    __try { release(future); release(scheduler); } __except (EXCEPTION_EXECUTE_HANDLER) { status = GetExceptionCode(); }
    return status;
}
// Used only to send a GIF sticker (kind 3). A build whose sticker path is not mapped (4.2) leaves them 0 and sends
// text and images only.
static bool stickerCall(int call) {
    return call == Emoticon || call == ValidateGif || call == ProbeGif || call == ReleaseProbe || call == EmoticonVtable;
}
static bool valid(const Request& request, uintptr_t base) {
    if (request.size != sizeof(Request) || request.pid != GetCurrentProcessId() || request.kind > 3 ||
        !memchr(request.account, 0, sizeof(request.account)) || !request.account[0] ||
        !memchr(request.target, 0, sizeof(request.target)) || !request.target[0] ||
        !memchr(request.value, 0, sizeof(request.value))) return false;
    __try {
        auto dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
        if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew < 64 || dos->e_lfanew > 1048576) return false;
        auto header = reinterpret_cast<const IMAGE_NT_HEADERS64*>(base + dos->e_lfanew);
        if (header->Signature != IMAGE_NT_SIGNATURE || header->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64 ||
            header->FileHeader.TimeDateStamp != request.timestamp || header->OptionalHeader.SizeOfImage != request.imageSize) return false;
        for (int call = 0; call < CallCount; ++call) {
            const auto rva = request.rva[call];
            if (rva >= request.imageSize || (!rva && (!stickerCall(call) || request.kind == 3))) return false;
        }
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
extern "C" __declspec(dllexport) DWORD WINAPI DshWechatSend(void* parameter) {
    if (!parameter) return ERROR_INVALID_PARAMETER;
    auto input = static_cast<Request*>(parameter);
    auto core = reinterpret_cast<uintptr_t>(GetModuleHandleW(L"Weixin.dll"));
    if (!core || !valid(*input, core)) return ERROR_NOT_SUPPORTED;
    try {
        auto job = std::make_shared<Job>(*input, core);
        if (!job->done || !job->owner) return ERROR_NOT_ENOUGH_MEMORY;
        std::function<void()> task = [job]() {
            Completion* completion = job->request.kind == 1 ? new Completion{1, 0, textCompleted, textDestroyed, job} : nullptr;
            execute(job.get(), completion);
        };
        auto status = enqueue(job.get(), &task);
        if (status) return status;
        if (WaitForSingleObject(job->done, 60000) != WAIT_OBJECT_0) {
            InterlockedExchange(&job->cancelled, 1);
            return WAIT_TIMEOUT;
        }
        input->status = job->request.status; input->stage = job->request.stage; input->exception = job->request.exception;
        return input->status;
    } catch (...) { return ERROR_GEN_FAILURE; }
}
BOOL WINAPI DllMain(HINSTANCE, DWORD, LPVOID) { return TRUE; }
