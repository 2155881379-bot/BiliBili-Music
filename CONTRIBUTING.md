# 参与开发

感谢你愿意改进这个小播放器。先在 Issue 中描述问题或目标，较大的功能建议先讨论范围，再开始实现。

## 环境与检查

推荐 Windows x64、Node.js 24 LTS、npm。

```powershell
npm ci
npm test
npm run typecheck
npm run build
```

修改播放器、收藏夹或队列时，请覆盖相应行为测试。属性测试使用 fast-check，失败时保留 seed/path 便于复现。`npm run test:perf` 是带时限的 Windows Electron 夹具测试，需要先构建；真实 B 站网络、系统媒体键和长时间播放仍需人工验证。

发布准备时已更新 Electron、Vite、Vitest 等依赖。2026-11-17 的 `npm audit` 结果为0项高危、0项严重、6项中等风险提示，均由 electron-builder 构建依赖链中的 minimatch 公告 [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) 传播而来；这些构建工具不作为应用运行时依赖分发。请持续检查上游修复，不要为了消除提示直接执行 `npm audit fix --force`，该命令当前建议降级 electron-builder。

不要提交 `node_modules/`、`out/`、`release/`、`output/`、真实用户状态、Cookie、日志或私人文件。截图和测试数据应使用合成内容。

## 报告问题

请提供应用版本、Windows 版本、操作步骤、预期结果和实际结果。性能问题请说明队列长度、前台/托盘状态、DPI，以及是否刚连续滚动了大量封面。

日志、截图和状态文件可能包含个人收藏、视频地址或本机路径，请先去除私人信息。无需提供账号 Cookie、密码或令牌。

## 提交 Pull request

从 `main` 创建分支，保持改动集中。PR 中写清楚问题、变化及验证结果。如果改变了 UI，请附使用合成数据的截图。

贡献的代码将按本项目 MIT 许可证分发。引入第三方代码或资源时，请一并说明来源、许可及需要保留的版权信息。
