# 交给她的安装说明

这份文件不是给人看的，是给 **DSH 里的陪伴角色**看的：谁把仓库地址发过来，谁就照着这份说明，把 `dsh-world` 装进 DSH、把 QQ 接上，最后让 QQ 里的她和人说话。

先说清 QQ 现在长什么样：**只有一条路——插件自己连 OneBot**（代码在 `src/ecosystem/qq-native/`，对外叫「原生通道」）。以前那个外部的桥进程已经在 2026-10-27 整段拆掉了，连它那几个配置项一起没了。所以这份说明里不会出现第二个进程，只有两样东西：插件，和负责登录 QQ 的 SnowLuma。

一句话说清边界：**第二步只有人能做——装 SnowLuma、拿手机扫码登录。这两件事你替不了，其余步骤你自己做。**

---

## 第零步：先摸清四件事

动任何文件之前，先把这四样查出来，后面每条命令都要用。

| 要知道的 | 怎么查 |
|---|---|
| `DSH_HOME` | Windows 默认 `C:\Users\<用户名>\.dsh`；看目录里有没有 `profiles`、`worlds` |
| 用哪个 profile | 列 `<DSH_HOME>/profiles/` 下的目录，挑 `package.json` 里 `dependencies` 有你正在跑的那些插件的那个 |
| node 版本 | `node -v`，必须 ≥ 22.16（dsh-world 的要求） |
| pnpm 在哪 | 先试 `pnpm -v`；没有就用 DSH 自带的：`<DSH 安装目录>\resources\runtime\x64\primary-runtime\dependencies\pnpm\bin\pnpm.cjs`，用 `node <那个 pnpm.cjs> <命令>` 调用 |

> macOS / Linux 的路径换成对应位置即可，命令不变。

---

## 已有 world：用编译包更新

已经装过 `dsh-world` 时，保留原 profile 和世界目录，不要另建 world。先下载编译好的 `.tgz`：浏览器直接打开 npm 上的安装包地址即可，例如 <https://registry.npmjs.org/dsh-world/-/dsh-world-0.6.6.tgz>，其他版本把地址里的两处版本号一起换掉；也可以从 [CI 运行记录](https://github.com/chenkezhen480/dsh-world/actions) 的 Artifacts 下载（需登录 GitHub，产物会过期）。更新成品无需 Git、npm 或 TypeScript 编译器；需要 Node ≥ 22.16、系统 `tar` 和 DSH 自带 pnpm。

1. 从应用菜单正常退出 DSH，等待微信适配器一并退出。脚本会拒绝在 DSH 或适配器仍运行时更新，不强制结束进程。
2. 使用仓库的 `scripts/update-world.mjs`，或已安装包的 `node_modules/dsh-world/scripts/update-world.mjs`。老版本尚无此文件时，可从仓库单独下载这个脚本，无需克隆或安装源码依赖。
3. 执行以下命令，将三个路径替换为实际值。`--pnpm` 指向桌面版启动日志中显示的 `pnpm.cjs` 或 `pnpm.mjs`；常见位置是 `<DSH 安装目录>/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`，旧安装也可能多一层 `x64`。

```powershell
node .\scripts\update-world.mjs `
  --profile '<DSH_HOME>/profiles/desktop' `
  --package '<下载目录>/dsh-world-0.6.6.tgz' `
  --pnpm '<DSH 自带 pnpm 的入口文件>'
```

`node` 可以使用本机 Node 或 DSH 提供的 Node 命令。macOS / Linux 使用同一脚本和参数，将换行符换成相应 shell 的写法即可。

脚本先检查包名和编译入口，再把整个 profile（含依赖）、`worlds` 和 `sessions` 备份到 `<DSH_HOME>/backups/dsh-world-<profile>-<随机后缀>/`。符号链接保留为链接，不复制链接指向的外部目录。安装包也保存到备份目录，profile 长期引用这份副本，下载文件随后移动或删除不影响启动。**不要删除当前 profile 仍在引用的备份目录。** 完整备份所需空间约为上述目录总大小；首次复制可能较慢。

更新只调用 pnpm 替换插件包，依赖安装脚本禁用，不安装或修补 SnowLuma SDK。随后核对编译入口、更新脚本、profile 配置、其他插件和世界／会话文件摘要。她的人设、日记、提示词、原会话及原模块配置保持原样，不自动迁移旧 QQ 配置，也不解锁微信待核对消息。外置微信状态不在该备份内，更新脚本不操作它。

失败会恢复整个旧 profile，保留 `failed-profile` 和备份供排查。若恢复也失败，保持 DSH 关闭，按报错给出的备份路径人工恢复；世界与会话备份不自动覆盖当前目录。检查覆盖包内容、文件摘要和入口语法；桌面版依赖宿主自己的模块加载器，脚本不尝试在普通 Node 中加载宿主人设或会话服务。正常完成后再启动 DSH，检查世界控制台健康状态。脚本不会自动启动 DSH、发消息或改她的自定义提示词。更新过程中请保持 DSH 关闭；若更新进程异常终止后遗留锁文件，先确认没有更新进程，再按报错路径处理锁文件及备份。

---

## 第一步：把 dsh-world 装进 profile

`dsh-world` 已发布到 npm，直接在 profile 目录安装，不用 clone、不用编译：

```bash
cd <DSH_HOME>/profiles/<你的 profile>
node <pnpm.cjs 路径> add dsh-world@latest --ignore-scripts --registry=https://registry.npmjs.org/
```

`--registry` 指定官方源，避免镜像还没同步到新版本。这条命令也可将旧的本地 `.tgz` 引用切换到 npm 版本，之后更新继续执行同一命令；但它不做备份，操作前退出 DSH 并备份原 profile 和世界数据，完成后重启，保留后文的 bundle 登记及个人配置。需要自动备份和失败恢复时，改用前文的 `scripts/update-world.mjs`。

QQ 功能额外依赖 **SnowLuma SDK（`@snowluma/sdk`）**。首次在控制台手动开启 QQ 时，若缺少 SDK，插件使用宿主提供的包管理器按需安装到当前 DSH profile，禁用安装脚本并检查 SDK 的 Node 要求；安装成功后提示重启 DSH，再启用 QQ。仅安装或启动 dsh-world 不会下载 SDK，不使用 QQ 时无需安装。插件不修补 SDK，也不自动升级 Node。

想用仓库里的源码（例如尚未发布的改动），自己打包再装：

```bash
git clone https://github.com/chenkezhen480/dsh-world.git

cd dsh-world
npm ci        # 仓库带 package-lock.json，能装全 devDependencies
npm pack      # 会先 typecheck + build，产出 dsh-world-<版本>.tgz
```

拿到 `dsh-world-<版本>.tgz` 的**绝对路径**，然后：

```bash
cd <DSH_HOME>/profiles/<你的 profile>
node <pnpm.cjs 路径> add <tgz 的绝对路径>
```

也可以自行安装；宿主未提供按需安装能力时，在同一个 profile 目录安装满足声明范围的 SDK（当前为 `^2.2.1`），确认 DSH 使用的 Node 满足 SDK 要求后再重启：

```bash
node <pnpm.cjs 路径> add @snowluma/sdk@^2.2.1
```

**不要用 `link:` 指向 clone 下来的目录。** 那样会加载项目自带的一份 Cordis，和 DSH 自己的打架。README 里也写了这句，别忽略。

接着改两个文件：

**1. `<profile>/package.json`** —— 在 `dsh.profile.bundles` 数组里加一项 `"dsh-world"`：

```json
"dsh": { "profile": { "bundles": [ "…", "dsh-world" ] } }
```

**2. `<profile>/cordis.patch.yml`** —— 让插件知道 QQ 从哪儿接进来：

- 文件里**已经有** `- id: dsh-world` 的话，只补 `config` 下这一段
- **没有**的话，整段贴到文件末尾

```yaml
- insert:
    - id: dsh-world
      name: dsh-world
      config:
        qqNative:
          enabled: true
          wsUrl: ws://127.0.0.1:3003            # OneBot 的 WS 服务端口（不是 HTTP 那个）
          accessToken: '<OneBot 的 WS 服务端自己的 token>'
          allowPrivate: [ '3475994805' ]        # 谁能私聊她，留空 = 谁都不理
          allowGroups: [ '681528723' ]          # 群白名单
          autoReply: true                       # false = 只看不回
          contextMessages: 6                    # 每轮带上最近的几条
          groupTrigger: mention                 # 群里被叫到才接（@ / 被引用 / 命中 groupKeywords）；all = 每句都接
          groupKeywords: []
          bindHomeSession: none                 # owner = 群各自独立、主人私聊用她的家会话；all = 都用家会话；none = 各建一个
          snowlumaHome: 'D:\SnowLuma'           # 去哪儿读 SnowLuma 的 config/runtime.json（控制台那扇门要用）；不填按 D:\SnowLuma、C:\SnowLuma、E:\SnowLuma、~/SnowLuma、~/snowluma 挨个认
          supervise: true                       # 看门狗：QQ 开着时端口不通就把 SnowLuma 拉起来；不想让插件动手就写 false
```

> 这一段**先照抄**：token、白名单、端口这些真值要等第二步人把 SnowLuma 装好才有，第五步再填。
> `qqNative.enabled` 写 `false`（或者整段不写）= 不接 QQ，控制台「QQ」页提示通道未开启。
> 写 `true` 也只是**允许**接 QQ：还要在控制台「概览 → 接入」把 QQ 拨开；缺少 SDK 时会按需安装并提示重启。没装 SDK 不影响插件的其他功能。
> 示例里 `bindHomeSession` 写了 `none`，是为了第一次联调不往她真正生活着的家会话里写东西；通道顺了以后改回默认的 `owner`（群各自独立、主人私聊用她的家会话）。
> 路径写 Windows 绝对路径，用正斜杠或单反斜杠都行。

---

## 第二步：装 SnowLuma，扫码登录，开 OneBot，把参数交给你（**只有人能做**）

### 2.1 装 SnowLuma 并扫码登录 QQ

- 下载：<https://github.com/SnowLuma/SnowLuma/releases/latest> 选 `SnowLuma-v<版本>-win-x64.zip`（完整版自带 Node 运行时；Lite 版要本机 Node 22.13+）
- 解压到任意目录，双击 `launcher.bat`
- 用**启动日志里打印的初始密码**登录 WebUI（地址也在日志里，通常是 `http://localhost:5099`）
- 按引导：同意条款 → 设置新密码 → **接入 QQ 进程（扫码）**

> **为什么这两件事不能自动化**：SnowLuma 的 EULA §5.4 明确禁止「通过自动化脚本部署」和「并入第三方安装包」。所以插件既不代装、也不代启动它，只连它开出来的 OneBot；装好一次之后，插件再也不碰它的安装目录。这不是我们偷懒，是对面写死的规矩。
> 另外扫码本身也要人拿手机。装好一次之后，以后重启不用再扫。

### 2.2 在 SnowLuma 里开 OneBot，把参数交给你

让人在 SnowLuma WebUI 里：

1. 开启 **WebSocket 服务端** → 记下端口（示例里写 `3003`，**以它页面上显示的为准**）
2. 开启 **HTTP API** → 也记下端口，但插件**不用**它，记下来只是为了别填错
3. 如果设了 accessToken，记下来 —— 你要的是 **WebSocket 服务端自己那个**

然后人把这几样告诉你：**WS 端口、WS 服务端的 accessToken（可能为空）、放行的 QQ 号、放行的群号**。

> **分不清两个 token 就看这里。** SnowLuma 给 HTTP 和 WebSocket 各生成一份 token，插件走的是 WebSocket 那条握手，拿 HTTP 那份会得到 `401`，卡上会直接写出来：`WS 错误: Unexpected server response: 401`。token 存在 SnowLuma 的 `config/onebot_*.json` 里 —— **认 `enableWebSocket` 为真的那个文件**，里面的 token 就是你要的。

---

## 第三步：重启一次 DSH

前两步改的都是「DSH 启动时才读」的东西：`bundles`、`cordis.patch.yml`。

所以现在**重启 DSH**。重启后验证两件事：

1. 打开 DSH 设置里的「世界控制台」，能看到世界卡——说明 dsh-world 起来了
2. 按一次「开始」，在「概览 → 接入」开启 QQ，再切到顶部 **QQ 页面**。状态是 `● 她自己的通道没连上`——说明 `qqNative.enabled` 生效了，只是还没填对参数（第五步才填）

> QQ 页在 `qqNative.enabled: true`、接入开关已开启且世界已经开始时展示详细状态；其他时候页面提示未开启。

---

## 第四步：确认你自己能做的都做完了

跑一遍这个判断，全绿再进第五步：

| 检查 | 怎么验 | 期望 |
|---|---|---|
| dsh-world 已加载 | 浏览器打开 `http://127.0.0.1:<DSH 端口>/dsh-world/worlds/<worldId>/console/snapshot` | 返回 JSON，有 `worldId`、`life`、`native` |
| 通道认了配置 | `http://127.0.0.1:<DSH 端口>/dsh-world/worlds/<worldId>/qq/native` | 返回的 `url` 是你填的 `wsUrl`；没连上时 `connected: false`、`lastError` 里写着原因。通道没开时这个端点返回 `null` |
| 世界在跑 | 控制台右上角是「停止」状态 | 通道跟着生活线一起起，世界没开始它不连 |

> 用浏览器而不是 curl：DSH 的 webServer 会校验 Host 头，curl 直接打会被挡。同源请求不受影响。

到这里，**你这一侧全部就绪**。剩下的是人必须插手的部分——也就是第二步已经做完的那两件事；做完之后你接手继续。

---

## 第五步：把参数填进去，接上（你来做）

拿到第二步那几个值，把第一步那段 `qqNative` 改真：

```yaml
        qqNative:
          enabled: true
          wsUrl: ws://127.0.0.1:3003
          accessToken: '<第二步拿到的 WS 服务端 token，没有就留空>'
          allowPrivate: [ '3475994805' ]        # 谁能私聊她；没填 ownerQQ 时，她自己开口的话推给这里面的第一个人
          allowGroups: [ '681528723' ]          # 要放行的群
          autoReply: true
          contextMessages: 6
          groupTrigger: mention
          groupKeywords: [ '小鱼' ]
          bindHomeSession: owner
          snowlumaHome: 'D:\SnowLuma'
```

改完重载插件（或者重启一次 DSH）就生效。**没有第二个进程要起**，QQ 这条线跑在插件自己的进程里。

两个坑，都会让人以为「装坏了」：

- **`wsUrl` 要填 OneBot 的 WebSocket 服务端端口**，不是 HTTP 那个。填错会一直连不上、日志刷重连。
- **`allowPrivate` / `allowGroups` 留空等于谁都不理**，不是「所有人都理」。白名单挡下的消息会计数，卡上显示 `· 挡下 N`。这是故意的，别指望它默认全接。

### 谁和谁共用一个会话

`bindHomeSession` 管的是这件事，值得单独说清楚：

| 值 | 效果 |
|---|---|
| `owner`（默认） | 主人私聊用她的「家会话」（`~/.dsh/worlds/<世界>/life.json` 里的 `homeSessionId`），**每个群各自一个独立会话**。群里聊的不会串到私聊，私聊里的记忆也不会漏进群 |
| `all` | 群里、私聊都用家会话，记忆完全共享；群里人多的时候上下文容易串味 |
| `none` | 谁都不绑：群各自一个，私聊也另建一个独立会话 |

> 自己开发调试这条通道时建议先写 `none`：测试回合不会写进她真正生活着的那条线，等通道彻底顺了再改回 `owner`。

规则是**每条消息现算的**，改完重载插件，下一条消息就按新规矩落会话。旧的频道会话留在原处不动（不自动拆，也不删）。

### 群里她什么时候接话

默认 `groupTrigger: mention`：只有这三种算在叫她，其余的**只记进上下文、不开口，也不烧一轮 token**：

- 被 `@` 到
- 引用她刚说过的那句话
- 文本命中 `groupKeywords` 里的词

写 `all` 就是群里每句都接 —— 那意味着群里每一条消息都会让她跑完一轮、还往群里冒一条，没人说话的时候也一样。**除非那个群本来就是你和她两个人的地方，否则别写 `all`。**

`contextMessages` 控制每轮带几条最近的上下文（默认 6）——群里那些没叫她的消息，价值就在这里：她看得见，但不接。

### 她自己开口

她在家里自己开的那一轮（闹钟、世界线）说完的话，会推一份给主人的 QQ：`ownerQQ`，空着就取 `allowPrivate` 的第一个人（白名单不止一人时一定要填）。有人说话的轮次是在回那个人，不另推。静默（`mutedUntil`，或卡上「静默到这个点」）期间也不推。

### 控制台 QQ 页面上有什么

「世界控制台」顶部「QQ」页里的状态卡写的是：`● 她自己连着 ws://…`（或「她自己的通道没连上」）+ `收 N 个会话 · 发 N 条[ · 失败 N][ · 挡下 N][ · 会自己回 / 只看不回]`，出问题会跟一句 `lastError`；下面一行是看门狗的状态（SnowLuma 通不通、拉起过几次、为什么拉不起来）。

下面是一排控件：

- **「会自己回话 / 只看不回」** —— 等于 `autoReply`。想只验链路通不通就先关掉：她会收、但一个字都不回，也不开会话、不花 AI 的额度。
- **「静默到这个点 / 立刻恢复」** —— 等于 `mutedUntil`：到点前只收不回、上下文照记，到点自己醒。
- **私聊 / 群白名单** —— 等于 `allowPrivate` / `allowGroups`，多个用逗号隔开；留空就是谁都不收。
- **「打开 SnowLuma 控制台」** —— 见下。
- **「拉起 SnowLuma」** —— 手动把 SnowLuma 拉起来一次，和看门狗走同一条路。
- **「刷新」** —— 重新拉一次快照。

这些都是**活的**：改完下一条消息就生效，不用重启。临时覆盖存在 `~/.dsh/worlds/<世界>/qq-native.json`；profile 里的值仍然是最底下的默认。

「概览 → 接入」里的 QQ 那一行管的是**通道本身**：关掉就断开这条 OneBot 连接，QQ 页提示未开启；再打开就恢复。状态记在 `world.json`。配置里没写 `qqNative.enabled: true` 时，这个开关按不动（控制台会明说）。

### SnowLuma 控制台那扇门

插件读 `snowlumaHome/config/runtime.json` 找 SnowLuma 的 WebUI 地址与端口，按钮点开就用系统浏览器打开、**带着登录票据**（`?token=…`），不用手输密码。

- **第一次**要先填一次 SnowLuma 的**面板密码**：那边只认密码，会话令牌只活在它的进程内存里。填对一次之后，密码记在 `<世界目录>/panel.json`（权限 600），以后点开就直接进。
- `snowlumaHome` 不填时，按 `D:\SnowLuma`、`C:\SnowLuma`、`E:\SnowLuma`、`~/SnowLuma`、`~/snowluma` 挨个认，认的是「里面有 `config/runtime.json`」这一条。

---

### 阳台：让本机别的程序也能跟她说上话

插件自己开一条 WebSocket（**默认关着**；在控制台 QQ 卡片上点「开这条线」就是 `ws://127.0.0.1:3210`，只认口令）。机器上任何会读写一行 JSON 的程序都能接上来，递一句话给她、听她回一句。设置页那张 QQ 卡上有地址、口令，还有一个「复制这条命令」——复下来的是一个现成的小程序，粘到对面就能用：

    DSH_QQ_BRIDGE_URL=ws://127.0.0.1:3210 DSH_QQ_BRIDGE_TOKEN=… node "<运行目录>/lib/qq-line.js" <这条线叫什么> <会话标识>

一条线就是她的一间屋子（`channel` 是 `qq-bridge`，会话标识是线名），和 QQ 那几条互不打扰。递话、回话都是一行 JSON：

    递给她   {"text":"…","from":"谁"}            直接说一句
             {"kind":"ring"}                      只敲一下门，不说话
    她回话   {"kind":"reply","threadId":"…","text":"…","hold"?:true}
             {"kind":"error","message":"…"}

她可以在回话里带上怎么对待门外，这两个词不会被当成话发出去：`[安静]`（这条线半小时内不再敲得动门）与 `[待一会]`/`[在忙]`（对面收到 `hold`）。口令存在世界目录的 `qq-bridge.json` 里，重启 DSH 对面那份不用改；端口在 `qqNative.bridge.port`（`0` = 不开，默认 3210）。

那张卡上会显示「阳台开着 ws://127.0.0.1:<端口> · 连着几条线 · 收了几句、回了几句、她开口几次」，出问题就看同一行的 `lastError`。

## 验证清单

按顺序过一遍，哪条不过就查下表：

1. `http://127.0.0.1:<DSH 端口>/dsh-world/worlds/<worldId>/qq/native` → `connected: true`，`url` 是你填的那个 ws 地址
2. DSH 里「世界控制台」→ QQ 卡：`● 她自己连着 ws://…`，`挡下 0`
3. QQ 上用一个在白名单里的号给她私聊发一条 → 她回
4. 群里 @ 她 → 她回；群里说一句没叫她的 → 她**不回**，但卡上的会话计数和上下文在走
5. 「概览 → 接入」里关掉 QQ → 通道断开、QQ 页提示未开启 → 再打开 → QQ 页恢复详细状态

## 出问题看这里

| 现象 | 真正的原因 |
|---|---|
| QQ 页提示通道未开启 | 检查 `qqNative.enabled: true` 是否位于正确的 `config:` 下、世界是否已开始，以及「概览 → 接入」的 QQ 开关是否已开启；若连 QQ 页入口都没有，再核对安装版本 |
| 卡上写 `WS 错误: Unexpected server response: 401` | `accessToken` 填成了 HTTP 服务的 token。要用 **WS 服务端自己那个**：SnowLuma 的 `config/onebot_*.json` 里 `enableWebSocket` 为真的那个文件 |
| 一直连不上，日志刷重连 | `wsUrl` 的端口填成了 HTTP API 那个。要填 WebSocket 服务端的端口，端口号以 SnowLuma 页面上显示的为准 |
| 私聊发了没反应，卡上「挡下 N」在涨 | 那个 QQ 号不在 `allowPrivate` 里。白名单留空 = 谁都不理，抬手加上去 |
| 群里 @ 她了，还是不接 | 群里默认 `groupTrigger: mention`，只有 @、引用她的消息、命中 `groupKeywords` 才算叫她；另外确认群号在 `allowGroups` 里（要数字，别写成别的字） |
| 她收得到但一个字不回 | `autoReply` 关着（卡上写着「只看不回」），或者卡上那个勾被拨掉了 |
| 她自己开口的话没推到 QQ | `ownerQQ` 和 `allowPrivate` 都空着（没处发）；或者正在静默；或者那一轮是在回别人的话 |
| 卡上写着「排队待发」 | 发送失败的消息在队里，每 3 秒重试一次，最多留 5 分钟；通道连回来就会发出去 |
| 点「打开 SnowLuma 控制台」说「还差一次面板密码」 | 第一次要先填一次 SnowLuma 的面板密码，填对了就记在 `<世界目录>/panel.json`，之后不用再填 |
| 点那扇门说「没找到 SnowLuma 的控制台配置」 | `snowlumaHome` 没填或填错；它要的是 SnowLuma 的**安装目录**（里面得有 `config/runtime.json`） |
| 设置页「模块」里的 QQ 开关按不动 | 配置里没写 `qqNative.enabled: true`，控制台不会凭空打开一个没配的模块 |

---

## 一句话总结给主人听

「装好了。以后重启电脑只要两件事：DSH 起来（QQ 那条通道跟着生活线一起起）、SnowLuma 自己重连。除非换 QQ 号，否则不用再扫码。」
