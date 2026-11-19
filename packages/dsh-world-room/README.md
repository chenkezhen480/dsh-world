# dsh-world-room

她的小屋：[dsh-world](https://github.com/chenkezhen480/dsh-world) 世界控制台「小屋」标签里的那间三渲二小屋。她做事时在书桌旁，休息时在床上，闲着时在屋里走动。

这个包不单独使用。在控制台的「小屋」标签里点「安装小屋」，dsh-world 会把它装进当前 profile；装一次，所有世界都能用。页面只读所在世界的控制台快照，不存任何东西。

## 里面有什么

- `index.html`、`js/`：页面和画小屋的脚本。
- `vendor/three/`：[three.js](https://threejs.org) r187，MIT，许可证在同一目录。
- `her/`：她的动画，来自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT），出处和许可证见 `her/NOTICE.md`。

## 版本

dsh-world 在自己的 `peerDependencies` 里写明要哪个版本范围的小屋。范围对不上时，控制台会提示更新。
