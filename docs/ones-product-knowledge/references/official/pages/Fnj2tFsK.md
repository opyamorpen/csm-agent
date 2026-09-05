# 集成AD用户目录

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/Fnj2tFsK
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 管理员手册 / 账号集成 / 第三方账号集成 / 集成LDAP/AD / 集成AD用户目录
Evidence: documentation, not runtime verification

## 集成AD用户目录

## 1.功能入口

管理员可在系统「团队配置中心」（多团队下「组织管理」）>「账号集成」页面，点击「添加账号集成」并选择「LDAP/AD」进行添加集成配置。

[image: image - 2024-04-26T160557.788.png; see source page]

## 2.配置步骤

### 2.1 添加AD

在【添加LDAP/AD】页面选择模式「AD」，并根据AD服务器信息填写主机地址、主机端口、安全协议、User DN、域等信息

注意：提交配置后，模式不可修改

如果选择通过「用户名@域名」获取邮箱，系统用户的邮箱将根据用户名 + @域名方式生成，而不直接通过AD同步

[image: image - 2024-04-26T160559.793.png; see source page]

#### 2.1.2 填写管理员账号

管理员账号用于授权 AD 用户数据访问，以获取和同步AD用户数据，根据AD服务器信息填写 Domain Search User 和 Domain Search Password

[image: image - 2024-04-26T160851.982.png; see source page]



#### 2.1.3 选择账号绑定方式

用于匹配AD账号和ONES系统已有账号，具体规则可查看 [账号绑定方式](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/Da3WEL7G)。

[image: _a9O5xU1K; see source page]

#### 2.1.4 用户属性映射

用于设置从AD同步的用户属性字段，以及AD属性字段和系统属性字段的映射关系，目前系统支持同步的字段包含：用户名、邮箱、工号、公司、职位

注意：需要保证用户的邮箱、工号是企业唯一的

[image: _loZCx4cY; see source page]

### 2.2 配置集成功能

添加集成后，进入【LDAP/AD详情】 可以选择需要启用集成功能。

#### 2.2.1 启用「用户目录同步」

启用「用户目录同步」可以获取AD“组织架构”的部门和人员。在【LDAP/AD详情】 > 【用户目录同步】页面，点击「配置同步」进入【配置同步】页面，配置部门同步信息。

- 定时同步：每10分钟ONES系统会从AD获取一次最新的成员和部门数据；

[image: image - 2024-04-26T161019.054.png; see source page]

#### 2.2.2 启用「登录验证」

启用「登录验证」后，已绑定AD账号的ONES用户（提示：[用户如何绑定第三方账号](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/Da3WEL7G)）通过AD登录到ONES系统。在【LDAP/AD详情】>【登录验证】点击「启用」，即可开启登录验证。

[image: image - 2024-04-26T161022.604.png; see source page]

启用「登录验证」后，系统登录页面将显示「LDAP」登录入口，点击可以进入LDAP登录页面，如下图所示。也可以通过「登录链接」直接打开LDAP扫码登录页面。

[image: image - 2024-04-26T161023.991.png; see source page]

登录时，账号输入无需增加域名后缀。如zhangsan@ones.cn，只需输入zhangsan。

[image: image - 2024-04-26T161125.548.png; see source page]

启用「登录即时创建成员」后，新用户通过AD登录到系统时，会自动创建账号并同步用户数据

注意：在「多团队」模式下，需要选择新用户默认加入的团队

### 2.3 移除集成

在【LDAP/AD详情】点击「移除集成」，在确认弹窗输入“移除LDAP/AD”即可移除集成，集成移除后，从AD获取的部门和已激活邮箱的用户将会保留，未激活邮箱的用户将会被清除。
