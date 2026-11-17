# 维护者发布流程

## 三个不同的动作

- **commit**：把一组文件变化保存为本地版本。
- **push**：把指定分支和提交传到 GitHub。
- **release**：为一个固定的 tag 添加用户可下载的安装包与版本说明。

默认分支 `main` 表示当前源码。tag（例如 `v0.1.0`）固定指向某个提交；已经公开的版本应通过新版本修复，避免覆盖原 tag 或文件。

## 准备版本

1. 修改 `package.json` 中的版本，更新锁文件和 `CHANGELOG.md`。
2. 运行 `npm ci`、`npm test`、`npm run typecheck`、`npm run build`。
3. 在 Windows 运行 `npm run dist`，再运行 `node scripts/packaged-smoke.cjs`。
4. 手测真实播放、seek、收藏夹、托盘、媒体键、退出和续播。未完成的项目写进版本说明。
5. 检查提交内容不含账号凭证、私人数据、机器路径或临时构建产物。

`CI` 工作流自动检查每次 push/PR。`Build Windows` 工作流由维护者手动触发，只上传构建产物，不自动创建或发布 Release。

## 发布

以下命令需要已登录 GitHub CLI，并在有 `origin` 的仓库中执行。先确认当前提交就是通过测试并用于打包的版本：

```powershell
git status --short
git log -1 --oneline
git tag -a v0.1.0 -m "BiliBili Music v0.1.0"
git push origin main
git push origin v0.1.0
```

计算两个 exe 的 SHA-256，将结果保存为 `release/SHA256SUMS.txt`，然后创建草稿：

```powershell
gh release create v0.1.0 --verify-tag --draft --prerelease --title "v0.1.0 — 首个公开测试版" --notes-file docs/releases/v0.1.0.md release/BiliBiliMusic-Setup-0.1.0.exe release/BiliBiliMusic-Portable-0.1.0.exe release/SHA256SUMS.txt
```

检查草稿的 tag、版本说明、文件名及校验值，确认附件完整后公开：

```powershell
gh release edit v0.1.0 --draft=false
```

`--prerelease` 表示测试版本，用户仍可下载；它不等于隐藏或私有。首版使用此标记明确成熟度。代码采用 MIT，依赖许可见根目录的 `THIRD-PARTY-NOTICES.txt`。
