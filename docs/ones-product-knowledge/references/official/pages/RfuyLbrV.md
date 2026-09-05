# 如何部署 Jira 迁移工具高级版

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/RfuyLbrV
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 数据迁移 / Jira数据迁移 / 迁移至 ONES 私有部署 / 如何部署 Jira 迁移工具高级版
Evidence: documentation, not runtime verification

## 如何部署 Jira 迁移工具高级版

## 1 部署前准备

### 1.1 基础准备

| 确保Jira服务器能正常请求ONES服务 | curl http://<ip:port>/project/api/project/importer/env_config<br><br>如果是https，则：<br><br>curl -k https://<ip:port>/project/api/project/importer/env_config<br><br>返回一段json信息则代表网络通信正常 |
| --- | --- |
| 关闭ONES定时备份功能（若有） | 迁移前临时关闭ONES定时备份功能，避免迁移过程碰上自动备份，影响数据迁移 |
| 关闭ONES第三方用户同步（若有） | 迁移前关闭 |
| 关闭ONES用户组同步插件（若有） | 迁移前关闭 |
| 关闭ONES中跟迁移数据有关系的插件（若有） | 迁移前关闭 |

### 1.2 复制附件

Jira 附件不包含在主数据迁移任务中。完成 Jira 主数据迁移后，需要通过迁移工具中的「复制附件」功能，将 Jira 附件复制到 ONES。

执行附件复制前，请登录 ONES 服务器，执行以下命令打开配置文件：

```Plain Text
ones-ai-k8s.sh vim config/private.yaml
```

在配置文件中增加以下配置：

```Plain Text
s3ProxyValidateHostList: "http://s3-proxy-service:8080,http://access-nodeport:30011,http://ONESIP:30011"

backToOriginWithFileServerEndpoint: "http://import-tools-files-back-service"

enableImportToolsFilesBack: "true"

importToolsServers: "JIRAIP:5001"
```

配置时请注意：

- 将 ONESIP 替换为实际的 ONES 服务器地址。

- 将 JIRAIP 替换为实际的 Jira 服务器地址。

- 如果 Jira 迁移工具未使用默认端口 5001，请将端口修改为实际使用的端口。

- importToolsServers 的值不需要添加 http:// 或 https:// 前缀。

- s3ProxyValidateHostList 中前两个地址为固定值，只需将 http://ONESIP:30011 中的 ONESIP 替换为实际地址。

保存配置文件后，执行：

```Plain Text
ones-ai-k8s.sh make setup-ones
```

等待约 3～5 分钟，确认相关容器完成重启。完成 Jira 主数据迁移后，返回 Jira 迁移工具，点击「复制附件」开始复制 Jira 附件。



## 2 部署手册

适用人员：运维、IT人员

### 2.1 Jira迁移工具原理

Jira迁移工具通过读取「Jira备份包」及「Jira附件」，使用HTTP的方式传输到ONES服务，以此实现数据迁移。

迁移过程需要读取以下三个目录：

- 备份包目录（默认）: ${JiraLocalHome}/export

- 附件目录（默认）: ${JiraLocalHome}/data/attachments

- 实际目录可能会与默认目录不同，具体可在Jira系统中查询实际目录地址



### 2.2 备份Jira系统数据

迁移前需要确保已经备份当前Jira系统

备份路径：Jira 主菜单 > Jira Settings (设置) > System (系统) > Backup manager (备份管理器) > Create backup (创建备份)



### 2.3 迁移工具安装到Jira 服务器下

首先下载最新版迁移工具：

[下载 migration-tool-linux-amd64-latest.zip](https://packages.ones.com/migration-tool/migration-tool-linux-amd64-latest.zip)

默认情况下，建议将 Jira 迁移工具安装到运行 Jira 实例的服务器上，以确保迁移工具能够正常读取 Jira 备份文件和附件。

安装命令：

```Plain Text
unzip migration-tool-*-*.zip && cd migration-tool-*-* && sudo chmod 755 -R scripts/ bin/
```



### 2.4 启动迁移工具

进入到scripts目录，执行：

```Plain Text
 sudo ./start.sh
```

- Please input product type (jira/cf) (default: jira):

  - 默认值即可

- Please input Migration Tool http port (default: 5001)

  - 迁移工具端口号，默认5001

- Please input Jira Attachment Path (default: /var/atlassian/application-data/jira/data/attachments):

  - 输入Jira的附件目录，默认为上一步输入的$Jira Local Home/data/attachments目录

- Please input cache path, at least 20G (default: /data/nas/importer/cache-5001):

  - 输入迁移工具缓存目录，需要确保有20G的空间，默认为/data/nas/importer/cache-5001

通过 浏览器 ip+端口 的形式访问迁移工具

[image: _a05v62ZM; see source page]
