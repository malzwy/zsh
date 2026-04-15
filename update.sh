#!/bin/bash

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}开始更新 Office Document Translator...${NC}"

# 1. 备份配置文件 (防止被覆盖)
if [ -f "config.json" ]; then
    echo -e "${GREEN}正在备份 config.json...${NC}"
    cp config.json config.json.bak
fi

# 2. 获取最新代码
# 如果您是使用 Git 部署的，取消下面行的注释:
# git pull

# 3. 安装依赖
echo -e "${GREEN}正在安装/更新依赖...${NC}"
npm install

# 4. 构建前端
echo -e "${GREEN}正在构建前端静态资源...${NC}"
npm run build

# 5. 恢复配置文件
if [ -f "config.json.bak" ]; then
    echo -e "${GREEN}正在恢复 config.json...${NC}"
    mv config.json.bak config.json
fi

# 6. 重启服务 (如果您使用 pm2)
if command -v pm2 &> /dev/null; then
    echo -e "${GREEN}检测到 pm2，正在重启服务...${NC}"
    pm2 restart translator || pm2 start npm --name "translator" -- run start
else
    echo -e "${YELLOW}未检测到 pm2，请手动重启您的服务。${NC}"
fi

echo -e "${GREEN}更新完成！${NC}"
