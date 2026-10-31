# dsh-world

给 DSH 里的陪伴角色一个会记得、会生活的世界。

装上以后，她会记得你们在每个窗口里说过的话；有一个自己的家，自己决定接下来做什么、做到几点，想你了会主动来找你；每天晚上回想这一天，写日记，也改写一份关于自己的自述。开关和人设都在 DSH 设置里的「世界控制台」，由你掌握。

插件只用 DSH 原本开放的扩展接口，不改宿主的一行代码。

**已拓展到微信和 QQ**：除了 DSH 里的窗口，她也能在 **微信** 和 **QQ** 里收发消息，私聊和群聊都可以，和家共用同一份记忆、同一个她。

- **微信模块**自带 Windows 适配器和原生发送，不依赖 `dsh-plugin-weixin` 等其他微信插件；只适配指定的微信构建，需要按适配器说明准备 Python 环境，有账号风险，见 [注意事项·微信](NOTES.md#微信)。
- **QQ 模块仍然需要外部的 SnowLuma**：插件自己连 OneBot，但登录 QQ、提供 OneBot 服务的是需要你另行安装的 SnowLuma，另外还要它的 SDK `@snowluma/sdk`（首次手动开启 QQ 时按需安装）。微信和 QQ 默认都是关的，要用先在控制台拨开；不用 QQ 时不需要装这些。见 [注意事项·QQ](NOTES.md#qq)。

当前版本 **0.6.5**。完整变更和升级说明见 [更新日志](CHANGELOG.md#065--2026-10-30)。

## 她能做到什么

### 记得：像人一样记

- **近期记忆**：你们最近数轮的对话原文，每次开始对话和每次压缩之后都放在她眼前，谁、什么时候、说了什么，一字不差。轮数在控制台里填，默认 200。
- **日记**：人生里重要的事，她自己写进日记，一天一篇。这是她的长期记忆。
- **我是谁**：她写给自己的一份自述，随着她变化而改写。每晚回顾前，插件会留一份当时的版本，改过的都找得回来。
- **范围内的原文留着**：按天归档用户和助手的正文。近期记忆以外的事，她可以自己去翻。
- **找得回去**：`recall` 按关键词翻聊天归档、日记和活动记录，返回原话片段和出处行号。它只是目录，不复制正文：源删了条目就跟着没，索引坏了直接重建。写下来的（日记）不随时间变淡，只经过的会褪色——想让哪件事一直清楚，就写进日记。

日记和自述都由她自己动笔，插件从不替她写。

**为什么不用向量库或记忆系统？** 一个人的生活，量没有那么大。在这个量级上，把原文留在眼前、需要时按原话去找，比切碎了再拼回来更准，也少一道会出错的环节。可参考：

- Chan et al., 2024. *Don't Do RAG: When Cache-Augmented Generation is All You Need for Knowledge Tasks*. arXiv:2412.15605
- Sen et al., 2026. *Is Grep All You Need? How Agent Harnesses Reshape Agentic Search*. arXiv:2605.15184

### 生活：她自己的日子

- **家**：她有一个自己的会话「<名字>的家」，和一个房间（工作目录），在里面过自己的日子。
- **自己定节奏**：她说好接下来做什么、做到几点，到点了再决定继续还是换一件。什么都不定，就休息到第二天早上。
- **主动找你**：想你的时候，她可以把一句话送到你面前（Windows 系统通知，或你接上的桌宠等程序）。
- **每日回顾**：每天晚上 23:00，她回想当天的聊天和做过的事，写日记，更新「我是谁」。
- **每天额度**：可以给家里每天的花费设个上限，超过了会提醒她一次，由她自己决定收尾。
- **大事先问**：删改房间外的文件、装软件、花钱、以你的名义对外发消息等，约定好先问你。

### 世界控制台：开关在你手里

DSH 设置里的「世界控制台」：

- **开始 / 停止**：按下开始，她才住进来；按下停止，记忆、人设和生活线一起安静下来，家还在，等你回来。
- **人设**：分层写她是谁：名字、她是谁、性格、说话方式、愿景、补充，旁边实时预览她读到的样子。写了以后，它取代 DSH 自带的那句默认身份（“You are an AI agent powered by DeepSeek Harness.”）；你已经在 DSH 里设过的系统人设（宿主设置里的人设，或当前预设自带的人设）不会被替换，原样保留，这里写的排在它后面；预设如果已经自己改写了那句默认身份，也按它写的保留，不会被盖掉。全部留空时什么都不改，沿用 DSH 的默认身份和你已有的人设，控制台不自动回填。DSH 里其余的系统提示（计划、工具和文件引用等说明）不动。
- **世界提示词**：你想对她说的话，以及她的世界的说明。
- **相册**：家会话可用 `keep_photo` 收藏本轮最新消息中的图片（含本轮已读取的微信图片和引用图），`list_photos` 分页查看说明，`forget_photo` 移除收藏。控制台顶部「相册」页查看照片，点开才加载图片；照片不会自动加入之后每轮上下文。旧相册首次打开时导入，原文件保留。
- **应用并压缩家会话**：人设和世界提示词页面里的热加载入口，操作方法见[注意事项](NOTES.md#修改人设和世界提示词后要手动应用)。
- **工作区权限**：选择世界工作区新建会话的默认权限，选项沿用宿主提供的权限预设，默认完全权限。保存后对新会话生效；已有会话及其手动权限不会被重新覆盖。
- **概览与记录**：她此刻在做什么、下个闹钟、近期记忆有多少轮、今天花了多少；还有活动记录、日记和压缩记录。
- **状态卡**：「概览」最上面那张卡是她自己的地方——心情（大字）、还剩多少精力、几个她想写的小标签（最多 4 个，今天几碗饭只是其中一个例子）、再加一句她想让人看到的话，都由她用 `set_status` 写。小标签写什么都行，这次给的整组替换；别的项没写就保持原样。她没写过就空着，不带默认值；超过 12 小时整张卡会变淡。健康故障不再用一张「● 一切正常」的卡占地方：有故障时概览里单独列出来。
- **接入开关**：配置里启用了微信（`wechat: true`）或 QQ（`qqNative.enabled: true`）后，概览里有一张「接入」卡片，状态记在 `world.json`。微信开着才注册工具并拉起适配器（配了 `wechatAdapter` 时），关掉就撤掉；QQ 开着才加载通道，关掉就断开连接。微信和 QQ 都默认关，已经在用微信的世界升级后保持开着。首次手动开启 QQ 时，缺少 SnowLuma SDK 就按需安装，完成后提示重启 DSH；SDK 已就绪时直接切换，无需重启。
- **微信 / QQ 页面**：顶部各有一个独立入口，详细状态和设置不再挤在概览里。微信页查看连接、待发送与待核对数量，重启适配器并调整读取条数和图片缓冲；QQ 页管理 OneBot、白名单、静默和 SnowLuma。通道关闭或世界停止时，页面提示未开启。
- **归档范围**：默认 `workspace`，归档家所在工作区的普通会话，包含独立微信群会话；`home` 仅当前家会话。保存范围后提示重启，重启前沿用原范围。启动时分页回扫所选范围内的会话日志，按消息实际时间重选最近配置轮数，下次请求前替换旧记忆块；没有时间过期。旧归档保留，范围外记录不再注入。旧配置 `world` 迁为 `workspace`。
- **注入范围**：世界记忆、世界提示词、世界线工具和微信/QQ 通道仅进入世界工作区内匹配预设的普通会话，其他工作区即使用相同预设也不会收到。归档选为 `home` 时，同工作区的其他会话仍可读取家记忆。

> 对世界工作区以外的会话，只有两项有影响：控制台人设和只留对话的压缩。详情见 [注意事项](NOTES.md#对世界工作区以外的影响)。

### 注意事项

容易踩的地方都集中写在 [注意事项](NOTES.md)，按主题分类。第一次装或升级之前，建议先看 [默认就会发生的事](NOTES.md#默认就会发生的事)。

- [安装与升级](NOTES.md#安装与升级)：默认换用只留对话的压缩。
- [人设与提示词](NOTES.md#人设与提示词)：改了以后要手动应用；控制台人设和 DSH 自带系统提示词怎么共存。
- [压缩与记忆](NOTES.md#压缩与记忆)：什么时候自动压缩、每日回顾后自动压缩。
- [世界范围与会话](NOTES.md#世界范围与会话)：对世界工作区以外的影响，以及“会话已离开世界工作区”怎么排查。
- [微信](NOTES.md#微信)：支持的版本、账号风险、图片和表情包、@、退出重开。
- [QQ](NOTES.md#qq)：SnowLuma SDK、群里默认只接被叫到的、看门狗。

### 只留下你们之间的话的压缩

对话太长需要压缩时，dsh-world 自带的压缩方式会去掉工具调用的过程，把你们之间的交流整理成一段摘要。她记住的是你，不是那些命令。装上插件后它默认就会换上，见 [注意事项](NOTES.md#默认就会发生的事)。

### 桌宠和其他程序

dsh-world 开放了一个本地的「桥」：桌宠之类的程序可以把你说的话送进她的家，也可以接收她的回复和主动找你的话。协议见文末。

微信作为独立模块接入同一个家，使用她的独立账号收发指定私聊或群聊。她可用 `wechat_chats` 查询已配置目标，用 `wechat_history` 主动分页查看群消息，无需等别人 @，历史里的图片用 `wechat_image` 按消息 ID 一张张看；读完以同一个 `chatId` 调用 `wechat_send` 自主联系对方或回复消息，文字、图片和表情共用同一发送队列；`wechat_delivery` 查询确认结果。普通最终回答不会自动转发到微信。Windows 适配器和配置步骤见 [微信模块](src/ecosystem/wechat/windows/README.md)。B 站尚未接入。

**群聊动静**：适配器在线时，已配置群里未 @ 她的消息只更新未读数、最后发言人和时间，不唤醒模型，也不把正文加入上下文。她原有的闹钟响起时，会附上一行群聊概况，包括未读消息或安静了多久；是否去看、是否发言，由她自己决定。成功读取群的最新一页后清零未读，自己的发言不计入未读；计数保存在适配器状态中，重启保留。插件不会改写你的 `alarm.md`、`world-prompt.md` 或「我是谁」。

微信的支持版本、账号风险、图片与表情包、表情库、@、退出重开等注意事项，见 [注意事项·微信](NOTES.md#微信)；首次接入与升级见 [注意事项·安装与升级](NOTES.md#微信首次接入与升级)。

> **QQ 走插件自己那条原生通道**：插件直接连 SnowLuma 提供的 OneBot WebSocket，自己收、自己发（代码在 [`src/ecosystem/qq-native/`](src/ecosystem/qq-native/index.ts)），中间没有第二个进程，也不需要别的 QQ 实现。SnowLuma 负责登录 QQ 并对外提供 OneBot 的 HTTP／WS 服务；它按自己的 EULA 不许被自动化脚本部署，装法与参数怎么拿见 [INSTALL.md](INSTALL.md)。这条通道的配置都在 profile 的 `cordis.patch.yml` 里（见下文「设置」），控制台上改过的设置存在世界目录的 `qq-native.json`。

外部生态接入代码统一放在 [`src/ecosystem/`](src/ecosystem/README.md)：`wechat/` 包含微信宿主模块、Windows 收发适配器和原生桥；`qq-native/` 是插件自己连 OneBot 的那条 QQ 通道（`qq/` 里是与它配套的控制台接口和 SnowLuma 控制台那扇门）；`shared/` 保存通用身份协议、群会话路由与消息出口；`bridge/` 为桌宠等本地程序提供通用桥。后续平台在同一目录下独立扩展，核心记忆、人设和生活线保持独立。

微信原生发送引擎单独适用非商业许可，详见该模块的许可说明。

### QQ

QQ 走插件自己那条原生通道：直接连 SnowLuma 开出来的 OneBot WebSocket，收文本、发文本，中途没有别的进程。代码在 [`src/ecosystem/qq-native/`](src/ecosystem/qq-native/index.ts)。

QQ 的 SDK 依赖、群里默认只接被叫到的、看门狗，以及 QQ 的记忆和接入开关，见 [注意事项·QQ](NOTES.md#qq)。

在 profile 的 `cordis.patch.yml` 里打开 `qqNative`（`enabled: true` 只是允许它存在）、填上 WS 地址与 token，再到控制台「概览 → 接入」把 QQ 拨开，切到顶部「QQ」页查看：连着哪个地址、收过几个会话、发过几条、挡下几条、排队待发几条、会自己回还是只看不回，一眼看到。页面里能直接拨「会自己回话 / 只看不回」，设「静默到某个时间点」（只收不回，到点自己醒），改私聊和群的白名单（留空就是谁都不收，改完不用重启），也能打开 SnowLuma 控制台、手动拉起 SnowLuma。这些改动记在世界目录的 `qq-native.json`，盖在配置之上。没配 `qqNative.enabled` 时，QQ 页提示通道未开启。

参数不对不会崩，只会连不上：卡上会把原因写在 `lastError` 里（比如 `WS 错误: Unexpected server response: 401`，说明填的是 HTTP 那份 token，该换成 WebSocket 那份）。QQ 页在通道启用、世界已经开始时展示详细状态，其他时候提示未开启。

**她怎么说话**：同一会话 `batchQuietMs`（默认 10 秒）内连着来的几句攒成一条再问她（最多等 30 秒），群里每句前面带着是谁说的。她的回答按空行分成几条发，中间停一下；回话里写 `[[img:路径]]`、`[[face:id]]`、`[[at:QQ号]]` 会变成图片、QQ 表情和 @，`[[sticker:开心]]` 按备注挑一个收藏表情单发（也可以写第几个），`[[qzone:正文]]` 发一条所有人可见的 QQ 空间说说。发不出去的消息先排队，每 3 秒重试，最多留 5 分钟。她在家里自己开的那一轮（闹钟、世界线）说完的话，也会推一份给主人（`ownerQQ`，空着取 `allowPrivate` 的第一个）；有人说话的轮次是在回那个人，不另推。

卡上那个「打开 SnowLuma 控制台」的按钮，读 `snowlumaHome` 下 `config/runtime.json` 里的地址与端口，带着一次性登录票据打开系统浏览器——第一次要先填一次 SnowLuma 的面板密码，之后记在世界目录的 `panel.json` 里（权限 600），不用再输。

## 安装

需要 DSH 桌面版，世界控制台和生活线都依赖它。

**最省事的办法**：把这个仓库地址交给她，让她照 [INSTALL.md](INSTALL.md) 自己装。那份说明是写给模型看的——每一步都有命令、判定和失败对照表，连同 QQ 怎么接进来、哪两个动作必须人来做，一路写到底。

**自己装**：`dsh-world` 已发布到 npm。在你的 DSH profile 目录用 DSH 自带的 pnpm 安装：

```powershell
node <DSH 自带 pnpm 的入口文件> add dsh-world@latest --ignore-scripts --registry=https://registry.npmjs.org/
```

装好后按 [安装说明](INSTALL.md#第一步把-dsh-world-装进-profile) 在 profile 里登记 bundle，重启 DSH，打开设置里的「世界控制台」，按需填写人设，按「开始」。

想用仓库源码时，执行 `npm ci`、`npm pack`，再用同一个 pnpm 把生成的 `dsh-world-*.tgz` 装进 profile；也可从 [CI](.github/workflows/ci.yml) 对应运行的 Artifacts 下载检查通过的编译安装包，Windows 和 Linux 分别提供产物。不要用 `link:` 指向项目目录，否则会加载项目自己的一份 Cordis。本机复现检查的命令见 [贡献协议](CONTRIBUTING.md#ci-与安装包验证)。

**已有 world 更新**：正常退出 DSH 后，用 [`scripts/update-world.mjs`](scripts/update-world.mjs) 指定原 profile、`.tgz` 和 DSH 自带 pnpm；`.tgz` 可直接从 npm 下载，例如 <https://registry.npmjs.org/dsh-world/-/dsh-world-0.6.4.tgz>。脚本先备份完整 profile、世界及会话，再更新并校验；失败恢复旧 profile，保留她已有文件。安装成品无需 Git、npm 或 TypeScript，完整命令与恢复说明见 [已有 world 升级](INSTALL.md#已有-world用编译包更新)。

**只留对话的压缩**：装好 `dsh-world` 后第一次启动，默认会把 profile 的压缩换成 `dsh-world/compaction`（先备份，重启 DSH 后生效），整个 profile 的会话压缩都会受影响。怎么关、怎么手动启用，见 [注意事项·安装与升级](NOTES.md#安装与升级)。

## 设置

大多数东西在世界控制台里改。其余的写在 profile 的 `cordis.patch.yml` 里，按 id 覆盖插件那一行，只写想改的项：

```yaml
- id: dsh-world
  name: dsh-world
  config:
    companionName: 小鱼          # 她的名字（控制台人设里写了名字时以人设为准），默认 TA
    partnerName: 伙伴            # 她对你的称呼，默认 伙伴
    worldId: default             # 世界名；换一个就是另一个世界、另一份记忆
    agentPreset: standard        # 她所在的预设
    timeZone: Asia/Seoul         # 默认系统时区
    life: true                   # 生活线，默认开启
    replaceCompaction: true      # 首次启动把 profile 的压缩换成 dsh-world 的只留对话压缩；false = 不动
    archiveScope: workspace      # workspace：家的工作区；home：仅当前家会话
    fallbackWakeTime: '09:00'    # 没定闹钟时，早上几点叫醒她
    diaryDir: C:/path/to/日记    # 日记目录，默认在世界目录里
    toast: true                  # 主动找你时发 Windows 系统通知
    # toastAppId: com.deepseek.dsh # 通知身份，默认在开始菜单里找 DSH 桌面版（com.deepseek.dsh 或 electron.app.DeepSeek Harness）
    bridge: false                # 打开本地的桥
    wechat: false                # 打开独立微信接口，需另行启动 Windows 适配器
    outlets: []                  # 接收她的话的本地程序，见文末
    allowedHosts: []             # 通过反向代理从局域网访问控制台时，放行的域名或 IP
    qqNative:                    # 插件自己连 OneBot（原生通道）；不写这一块就是不接 QQ
      enabled: false             # 打开通道：连上、控制台里出 QQ 卡
      wsUrl: ws://127.0.0.1:3003 # OneBot 的 WS 服务地址（不是 HTTP 那个）
      accessToken: ''            # OneBot WS 服务端自己的 token，与 HTTP 那份不是一码事
      allowPrivate: []           # 谁能私聊她；留空 = 谁都不理
      ownerQQ: ''                # 她自己开口的话推给谁；空着取 allowPrivate 的第一个
      allowGroups: []            # 群白名单
      autoReply: true            # false = 只看不回
      contextMessages: 6         # 每轮带上最近的几条
      batchQuietMs: 10000        # 同一会话这几毫秒内的话攒成一条问她；0 = 一条一问
      groupTrigger: mention      # mention：@ 她／引用她／命中关键词才接；all：每句都接
      groupKeywords: []          # groupTrigger: mention 时算「在叫她」的词
      mutedUntil: ''             # 静默到这个时间（ISO）：只收不回，到点自己醒
      bindHomeSession: owner     # owner：主人私聊用家会话、群各自独立；all：都用；none：各建一个
      snowlumaHome: ''           # SnowLuma 安装目录：控制台那扇门、看门狗和「拉起 SnowLuma」都靠它
      supervise: true            # 看门狗：端口不通就把 SnowLuma 拉起来
```

**压缩的配置**写在压缩那一行的 `config` 里（profile 的 `cordis.patch.yml` 中 `name: 'dsh-world/compaction'` 那一条），不是上面 `dsh-world` 这一行：

```yaml
- id: compaction-basic
  name: 'dsh-world/compaction'
  config:
    thresholdRatio: 0.75           # 用量超过上下文窗口的这个比例就压缩，默认 0.75
    defaultContextWindow: 1048576  # 适配器没声明窗口的模型按这个估算，默认 1M
    auto: true                     # false = 只手动压缩（「应用并压缩家会话」仍可用）
    # maxTokens: 65536             # 压缩时摘要回复的长度上限
    # headroomTokens: 65536        # 不再影响触发点；只在没写 maxTokens 时当作摘要回复的长度
    # maxOverflowRetries: 1        # 请求被模型以“超出窗口”拒绝后，压缩重试的次数
    # modelPolicies: []            # 按 provider/model 单独写上面的项，例如给一个窗口只有 128k 的自建模型写 defaultContextWindow
```

触发点怎么算、窗口值从哪来，见 [注意事项](NOTES.md#自动压缩什么时候触发)。

**改她的措辞**：世界提示词可以直接在控制台里改。闹钟响时、提前停下时、每日回顾时她收到的话，在世界目录里放一份 `alarm.md` 就能按段覆盖，段落名和可用的占位符见 `templates/alarm.md`。插件写给她的话一律用第一人称「我」，读起来是她自己的念头。

**时间**：建议把预设里 `time-context` 条目的 `refreshIntervalMs` 设为 `0`，让她每一步都知道现在几点。

## 她的东西放在哪

都在 `<DSH_HOME>/worlds/<worldId>/` 下（`DSH_HOME` 默认是用户目录下的 `.dsh`）：

| 位置 | 是什么 |
|---|---|
| `conversations/` | 按天归档的聊天原文（给人看的导出，正本在 `archive.sqlite`） |
| `room/` | 她的房间；`room/我是谁.md` 是她的自述 |
| `diary/` | 她的日记（可用 `diaryDir` 换位置） |
| `persona.md`、`world-prompt.md`、`alarm.md` | 你写给她的人设、世界提示词和闹钟措辞 |
| `world.json` | 世界是否在运行、每天额度、近期记忆轮数和选定归档范围 |
| `status.json` | 状态卡的内容：她自己写的心情、精力、今天几碗饭和一句话 |
| `activity/` | 她在家里用过的工具，只记录，不进记忆 |
| `recall.sqlite` | `recall` 的检索索引，只存词和指向原文的行号；删掉会在下次检索时重建 |
| `photos/album.sqlite` | 收藏的图片、说明与标签；首次导入旧相册后仍保留原文件 |
| `wechat.json` | 本机微信模块的地址、令牌和协议版本，不应公开 |
| `wechat-outbox.sqlite` | 微信工具安排的发送队列和确认状态 |
| `qq-native.json` | 控制台上 QQ 卡改过的设置（会不会自己回话、静默到几点、白名单、阳台端口），盖在 profile 默认之上 |
| `panel.json` | SnowLuma 控制台那扇门的登录票据，权限 600，不应公开 |

备份时整个目录一起备份即可，最好先停止 DSH。

## 桥与推送协议

给桌宠等本地程序用。

**把话送进她的家**（`bridge: true`）：插件启动时写出 `<世界目录>/bridge.json`，内容是 `{ origin, token, name, ... }`。向 `POST {origin}/dsh-world/bridge/say` 发 `{ "text": "..." }`，请求头带 `x-dsh-world-token: <token>`，会立即返回 `202`。这句话会作为你本人说的话进入她的家和记忆。

**接收她的话**（`outlets`）：每个目标写一个 `name`，地址用 `url`（其中 `{origin}` 会被替换），或者用 `urlFile` + `path`（端口会变的程序用这个）；再用 `kinds` 选择要接收哪些：`reply` 是桥上那句话的回复，`busy` 表示她正忙，`reach` 是她主动找你。插件会向目标 `POST`：

```json
{ "text": "她的话（纯文本）", "kind": "reply", "name": "她的名字", "images": ["http://…"], "image": "表情名" }
```

目标回复 2xx 就算送到。送不到的会显示在控制台的「健康」里。

## 参与贡献

**PR 统一提到 `dev` 分支**，`main` 由维护者从 `dev` 并入后发布，详见 [贡献协议](CONTRIBUTING.md#分支与-pr)。新增 QQ、B 站等生态模块前，请阅读 [贡献协议](CONTRIBUTING.md)：平台代码放在 `src/ecosystem/<channel>/`，复用统一身份、会话和归档能力；涉及内核的修改必须说明原因、影响、兼容性与验证结果。几条硬性要求：一个 PR 只做一件事；平台 SDK 只能是可选依赖，模块默认关闭，新依赖要先开 Issue；她的主动性来自她自己的安排，插件不往对话里推提醒，改动生活线核心或给她新增工具之前先开 Issue 讨论。

## 许可

MIT
