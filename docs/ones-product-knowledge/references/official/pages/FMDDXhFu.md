# 集成SAML

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/FMDDXhFu
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 管理员手册 / 账号集成 / 第三方账号集成 / 集成SAML
Evidence: documentation, not runtime verification

## 集成SAML

## 1.功能入口

管理员可在系统【团队配置中心】（多团队下【组织管理】）>【账号集成】页面，点击「添加账号集成」并选择「SAML」进行添加集成配置。

[image: image - 2024-04-26T161722.064.png; see source page]

## 2.配置步骤

### 2.1 添加SAML

支持连接企业SAML身份验证服务，实现企业用户单点登录。系统支持SAML 2.0标准协议。

#### 2.1.1 填写服务器信息

在【添加SAML】页面选择模式「SAML」，并在「添加SAML」>「配置SAML连接」中填写Idp的服务器地址、公钥等信息。

[image: image - 2024-04-26T161726.012.png; see source page]

#### 2.1.2 配置服务提供方元数据

将ONES设置为SAML的服务提供方（SP），并在Idp服务器中配置ONES系统的元数据，元数据中包含了SP的实例ID、回调地址等信息。

[image: image - 2024-04-26T161846.141.png; see source page]

#### 2.1.3 选择账号绑定方式

用于匹配SAML账号和ONES系统已有账号，具体规则可查看[账号绑定方式](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/Da3WEL7G)。

[image: image - 2024-04-26T161928.111.png; see source page]

#### 2.1.4 用户属性映射

用于设置从SAML同步的用户属性字段，以及SAML属性字段和系统属性字段的映射关系，目前系统支持同步的字段包含：用户名、邮箱、工号、公司、职位

注意：需要保证用户的邮箱、工号是企业唯一的

[image: _OLt0vYq2; see source page]

### 2.2 配置集成功能

添加集成后，进入【SAML详情】 可以选择需要启用集成功能。

[image: image - 2024-04-26T162707.072.png; see source page]

#### 2.2.1 启用「登录验证」

启用「登录验证」后，已绑定SAML账号的ONES用户通过SAML账号密码登录ONES系统。在【SAML详情】>【登录验证】点击「启用」，即可开启登录验证。

[image: image - 2024-04-26T162710.259.png; see source page]

启用「登录验证」后，系统登录页面将显示「SAML」登录入口，点击可以进入SAML账号登录页面，如下图所示。

[image: image - 2024-04-26T162714.812.png; see source page]

启用「登录即时创建成员」后，新用户通过「SAML」登录到系统时，会自动创建账号并同步用户数据。

注意：在「多团队」模式下，需要选择新用户默认加入的团队

### 2.3 移除集成

在【SAML详情】点击「移除集成」，在确认弹窗输入“移除SAML”即可移除集成，集成移除后，从SAML登录创建且已激活邮箱的用户将会保留，未激活邮箱的用户将会被清除。
