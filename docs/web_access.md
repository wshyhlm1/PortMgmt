# PortMgmt 网页访问与部署

## 本地访问

```bash
npm install
npm run daily
```

打开：

```text
portfolio_reports/index.html
```

报告目录保留历史日期：

```text
portfolio_reports/<YYYY-MM-DD>/<YYYY-MM-DD>.html
portfolio_reports/<YYYY-MM-DD>/<YYYY-MM-DD>.json
portfolio_reports/<YYYY-MM-DD>/<YYYY-MM-DD>.md
```

`portfolio_reports/index.html` 和 `portfolio_reports/archive.html` 必须由 `npm run build-site` 生成。

## GitHub Pages

1. 推送仓库到 GitHub。
2. Settings -> Actions -> General -> Workflow permissions 选择 `Read and write permissions`。
3. Settings -> Secrets and variables -> Actions 可选配置：
   - Variables: `REPORT_TZ=Asia/Shanghai`
   - Variables: `REPORT_HOUR=8` 或 `8,21`
   - Variables: `REPORT_DAYS=*` 或 `1-5`
4. 如需静态密码门，Secrets 设置 `PORTMGMT_PASSWORD`；可选 Variables 设置 `PORTMGMT_REMEMBER_DAYS=45`。
5. Actions 中手动触发 `Portfolio Management Report`，首次成功后会创建 `gh-pages` 分支。
6. Settings -> Pages -> Source 选择 `Deploy from a branch`。
7. Branch 选择 `gh-pages`，目录选择 `/ (root)`。
8. 访问 `https://<username>.github.io/<repo>/`。

外部 API key 放 GitHub Actions Secrets。非秘密配置，如 `REPORT_TZ`，放 GitHub Actions Variables。

workflow 会先从 `gh-pages` 恢复历史 `portfolio_reports`，再跑公开数据 enrichment、财务历史、行情、渲染和 `validate-report`。发布目录只包含 `portfolio_reports/`，不会发布 `.env.local`、`uploads/` 或完整 `data/`。

设置 `PORTMGMT_PASSWORD` 后，workflow 会在质量校验通过后加密所有发布 HTML，并写入 `robots.txt` 禁止索引。访问者输入共享密码后在浏览器本地解密，密码不会发送到 GitHub Pages。

## 自托管 nginx

服务器侧：

```bash
sudo mkdir -p /var/www/portmgmt
sudo chown www-data:www-data /var/www/portmgmt
```

nginx server block 示例：

```nginx
server {
    listen 80;
    server_name your-domain;

    root /var/www/portmgmt;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
```

启用后可用 certbot 配置 SSL：

```bash
sudo certbot --nginx -d your-domain
```

本地 `.env.local`：

```bash
DEPLOY_HOST=user@server
DEPLOY_PATH=/var/www/portmgmt
```

部署：

```bash
npm run deploy
npm run deploy -- 2026-06-04
```

缺少 `DEPLOY_HOST` 或 `DEPLOY_PATH` 时，deploy 会输出 skip 并以 0 退出。

## 数据与隐私

- `uploads/` 保存用户导入的原始 Markdown/CSV/Excel/Word/PDF。
- 当前首版只结构化 Markdown 与简单 CSV；Excel/Word/PDF 已保留 adapter stub。
- 公开 GitHub Pages 前，请检查 `portfolio_reports/*.html` 是否包含不应公开的持仓、研报摘要或内部路径。
- 原始研报和完整上传文件不应发布到公开站点。
