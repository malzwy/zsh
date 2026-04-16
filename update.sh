#!/bin/bash

# 开启严格模式：遇到任何错误立即退出脚本，防止错误级联
set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# 确保脚本在它所在的目录执行，防止在其他路径调用时找不到 config.json
cd "$(dirname "$0")"

echo -e "${YELLOW}开始更新 Office Document Translator...${NC}"

# 1. 备份配置文件
if [ -f "config.json" ]; then
    echo -e "${GREEN}正在备份 config.json...${NC}"
    cp config.json config.json.bak
fi

# 设置错误捕获：如果在第2-4步中途发生错误导致脚本退出，自动恢复配置
trap 'echo -e "${RED}更新过程中发生错误，正在尝试回滚配置文件...${NC}"; [ -f "config.json.bak" ] && mv config.json.bak config.json' ERR

# 2. 获取最新代码
echo -e "${GREEN}正在拉取最新代码...${NC}"
# 固化稳定的镜像站地址与协议，防止网络波动导致中断
git remote set-url origin https://gitclone.com/github.com/malzwy/zsh.git
git config --local protocol.version 1
git config --local http.sslVerify false

# 明确指定拉取远程的 main 分支 (根据之前日志，主分支是 main)
git pull origin main || git pull origin master

# 3. 安装依赖
echo -e "${GREEN}正在安装/更新依赖...${NC}"
npm install

# 4. 构建前端静态资源...
echo -e "${GREEN}正在构建前端静态资源...${NC}"
npm run build

# 取消错误捕获（因为构建成功，准备正常恢复配置）
trap - ERR

# 5. 恢复配置文件
if [ -f "config.json.bak" ]; then
    echo -e "${GREEN}正在恢复 config.json...${NC}"
    mv config.json.bak config.json
fi

# 6. 重启服务
if command -v pm2 &> /dev/null; then
    echo -e "${GREEN}检测到 pm2，正在重启服务...${NC}"
    pm2 restart translator || pm2 start npm --name "translator" -- run start
else
    echo -e "${YELLOW}未检测到 pm2，请手动重启您的服务。${NC}"
fi

echo -e "${GREEN}更新成功！${NC}"
