# 集成钉钉

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/LpdWeLJj
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 管理员手册 / 账号集成 / 第三方账号集成 / 集成钉钉
Evidence: documentation, not runtime verification

## 集成钉钉

## 1.功能入口

单团队管理员可在「团队配置中心」-「账号集成」页面，多团队管理员可在「组织管理」-「账号集成」页面，点击「添加账号集成」并选择「钉钉」进行添加集成配置。

[image: Group 14900540.png; see source page]

## 2.配置步骤

### 2.1 添加钉钉

#### 2.1.1 新建钉钉应用

打开系统的钉钉配置页面，同时进入[钉钉开发者后台](https://open-dev.dingtalk.com/)，点击「应用开发」>「创建应用」，应用名称等信息可按需自行填写。

[image: image.png; see source page]

#### 2.1.2 创建后，选择网页应用进入

[image: _BhFvWixe; see source page]

#### 2.1.3 配置应用首页与回调地址

- 配置应用首页地址与PC端首页地址

  1. 打开钉钉应用的「网页应用」

  2. 将系统后台的「应用首页地址」，复制至钉钉应用的「应用首页地址」和「PC端首页地址」中，保存生效

[image: Group 2.png; see source page]

- 配置安全设置

  1. 打开钉钉应用的「安全设置」

  2. 将系统后台的「授权回调域」，复制至钉钉应用的「重定向URL（回调域名）」中，保存生效

[image: Group 3.png; see source page]

#### 2.1.4 配置应用权限

进入「权限管理」，申请获取以下权限：

通讯录个人信息读权限

调用SNS API时需要具备的基本权限

邮箱等个人信息

成员信息读权限

企业员工手机号信息

通讯录部门信息读权限

通讯录部门成员读权限

企业已安装的应用列表查询权限

[image: Group 4.png; see source page]

#### 2.1.5 发布应用版本

进入「版本管理与发布」，创建新版本，按需配置应用可见范围，保存并发布应用

[image: Group 5.png; see source page]

#### 2.1.6 将发布后的应用凭证信息复制粘贴至系统中

[image: Group 6.png; see source page]

#### 2.1.7 选择账号绑定方式

「账号绑定方式」用于匹配钉钉账号和ONES系统已有账号，具体规则可查看[账号绑定方式](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/Da3WEL7G)。

[image: image - 2024-04-26T155431.751.png; see source page]

#### 2.1.8 用户属性映射

用于设置从钉钉同步的用户属性字段，以及钉钉属性字段和ONES系统属性字段的映射关系，目前系统支持同步的字段包含：用户名、邮箱、工号、公司、职位

注意：需要保证用户的邮箱、工号是企业唯一的

[image: image 59.png; see source page]

查看钉钉属性字段：进入「钉钉开发平台」>「开发文档」>「[服务端](https://open.dingtalk.com/document/orgapp-server/query-user-details)」，查看「通讯录管理 - 用户管理 - 查询用户详情」中「返回参数」提供的属性字段

###### 钉钉属性字段参考

| 名称 | 描述 |
| --- | --- |
| name | 用户名 |
| email | 邮箱 |
| job_number | 工号 |
| title | 职位 |

### 2.2 配置集成功能

添加集成后，进入【钉钉详情】 可以选择需要启用集成功能。

#### 2.2.1 启用「用户目录同步」

启用「用户目录同步」可以获取钉钉“组织架构”的部门和人员。

在【钉钉详情】 > 【用户目录同步】页面，点击「配置同步」进入【配置同步】页面，选择同步方式。

- 定时同步：每10分钟ONES系统会从钉钉获取一次最新的成员和部门数据；

- 事件消息同步：当钉钉组织架构数据发生变动时，ONES系统会从钉钉获取一次最新的成员和部门数据。

开启「事件消息同步」需要先将ONES系统提供的加密 aes_key、签名 token 和请求网址复制并粘贴到钉钉自建应用中。

[image: image - 2024-04-26T155437.288.png; see source page]

配置加密 aes_key、签名 token 和请求网址：进入「事件订阅」，将加密 aes_key、签名 token 和请求网址复制并粘贴到钉钉自建应用中

[image: image.png; see source page]

添加事件消息：配置请求网址后，需要在「事件订阅」中添加以下「通讯录事件」。

[image: image - 2024-04-26T155440.245.png; see source page]

#### 2.2.2 启用「登录验证」

启用「登录验证」后，组织登录页面将显示「钉钉」登录入口，点击可以进入钉钉扫码登录页面；也可以通过「登录链接」直接打开钉钉扫码登录页面。

[image: Group 14900541.png; see source page]

已绑定钉钉账号的ONES用户通过钉钉登录ONES系统。

未绑定钉钉账号的ONES用户通过钉钉登录后，若开启「用户目录同步」或「登录即时创建成员」，将自动创建账号

[image: Group 14900542.png; see source page]

注意：在「多团队」模式下，需要选择新用户默认加入的团队

#### 2.2.3 启用「消息通知」

开启「消息通知」，并在相关业务（如工作项通知、工作项提醒、Wiki页面组设置-通知）中启用钉钉通知，触发通知后，已绑定钉钉账号的成员成员可在钉钉收到 ONES 消息通知

[image: _Gb_5Q6K3; see source page]

### 2.3 移除集成

在【钉钉详情】点击「移除集成」，在确认弹窗输入“移除钉钉”即可移除集成，集成移除后，从钉钉获取的部门和已激活邮箱的用户将会保留，未激活邮箱的用户将会被清除。
