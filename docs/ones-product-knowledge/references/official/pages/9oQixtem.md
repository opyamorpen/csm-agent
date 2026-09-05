# 集成企业微信

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/9oQixtem
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 管理员手册 / 账号集成 / 第三方账号集成 / 集成企业微信
Evidence: documentation, not runtime verification

## 集成企业微信

## 1.集成能力

| 序号 | 能力类型 | 描述 |
| --- | --- | --- |
| 1 | ONES 消息通知到企业微信 | ONES 中产生的消息将通知到企业微信，并且支持点击查看详情页面。 |
| 2 | 同步成员与组织架构到 ONES | 以企业微信成员与组织架构作为数据源（User Provider），同步到 ONES 实现快速启用与统一账号管理。 |
| 3 | 通过企业微信登录到 ONES | 通过企业微信的账号验证服务，登录到已绑定的 ONES 中，实现安全快捷单点登录。 |

## 2.功能入口

管理员可在系统「团队配置中心」（多团队下「组织管理」）-「账号集成」页面，点击「添加账号集成」并选择「企业微信」进行添加集成配置。

[image: _fredazIU; see source page]

## 3.配置步骤

### 3.1 添加企业微信

私有部署版/高可用部署版用户，需要通过创建企业微信自建应用的方式实现 ONES 与企业微信的集成。

[企业微信自建应用创建指南](https://developer.work.weixin.qq.com/tutorial/h5-application)

#### 3.1.1 填写应用信息

在「添加企业微信」页面，按照提示填写企业ID、Agentld、Secret即可。

[image: _grBCkOTv; see source page]

获取企业 ID 信息：点击“企业微信管理后台”进入我的企业获取企业 ID，如下图所示。

[image: _EbMbq9Ob; see source page]

获取Agentld、Secret信息：点击“企业微信管理后台”进入应用管理 > 应用详情获取AgentId和Secret，如下图所示。

[image: _BaZvKjNS; see source page]

#### 3.1.2 配置自建应用

配置企业微信应用的可信IP，并将「添加企业微信 - 配置自建应用」中的应用主页、可信域名、授权回调域复制并粘贴到企业微信应用配置中。

[image: _apQYRxYU; see source page]

配置应用主页：进入「自建应用详情页」，将企业服务器的 IP 地址复制并粘贴到「开发者接口」>「企业可信 IP」中，仅所配 IP 可通过接口获取企业数据。

注意：根据企业微信[自建及代开发应用安全性升级](https://developer.work.weixin.qq.com/community/announcement/detail?content_id=16334603338859177543)策略，自2022年6月28日开始，企业新开启的通讯录同步和新创建的自建应用，需将本企业服务器的IP地址配置到新增的“企业可信IP”字段，仅所配IP可调用企业微信接口。若未配置“企业可信IP”，则该应用无法调用企业微信接口。

[image: _N5guL22K; see source page]

#### 3.1.3 账号绑定方式

「账号绑定方式」用于匹配企业微信账号和ONES系统已有账号，具体规则可查看账号绑定方式

#### 3.1.4 用户属性映射

用于设置从企业微信同步的用户属性字段，以及企业微信属性字段和系统属性字段的映射关系，目前系统支持同步的字段包含：用户名、邮箱、工号、公司、职位

注意：

1. 需要保证邮箱、工号是企业唯一的

2. 根据企业微信最新接口规则，用户的邮箱、地址等敏感字段，需要员工本人在通过企业微信首次登录 ONES 时进行授权后才能获取

[image: _PNXUcu4F; see source page]

查看企业微信属性字段：进入【开发者中心】>【开发文档】>【[服务端API](https://developer.work.weixin.qq.com/document/path/90196)】，查看【通讯录管理 - 读取成员】中「参数说明」提供的属性字段

[image: _LLzl9O8G; see source page]

### 3.2 配置集成功能

添加集成后，进入【企业微信详情】 可以选择启用集成功能。

[image: _5rTY54bd; see source page]

#### 3.2.1 启用「用户目录同步」

启用「用户目录同步」可以获取企业微信“通讯录”的部门和用户数据。在【企业微信详情】 > 【用户目录同步】页面，点击「配置同步」进入【配置同步】页面，选择同步方式。

- 定时同步：每10分钟ONES系统会从企业微信获取一次最新的部门和用户数据；

- 事件消息同步：当企业微信通讯录数据发生变动时，ONES系统会从企业微信获取一次最新的部门和用户数据。

开启「事件消息同步」需要先将ONES系统提供的URL、Token、EncodingAESKey复制并粘贴到企业微信自建应用中。

[image: _eHe4ZRcH; see source page]

配置URL、Token、EncodingAESKey：进入「企业微信管理后台」>「管理工具」 > 「通讯录工具」 > 「设置接收事件服务器】，将ONES系统提供的「URL」、「Token」、「EncodingAESKey」复制并粘贴到企业微信的配置中，如下图所示。

[image: _ixm9HZ04; see source page]

[image: _hucZMEaz; see source page]

配置完成后，点击「启用」即可启用「用户目录同步」。

#### 3.2.2 启用「登录验证」

启用「登录验证」后，已绑定企业微信账号的ONES用户（提示：[用户如何绑定第三方账号](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/Da3WEL7G)）通过企业微信扫码登录ONES系统。在【企业微信详情】>【登录验证】 点击「启用」，即可开启登录验证。

[image: _JIYOBo5f; see source page]

用户的邮箱、地址等敏感字段，需要员工本人在通过企业微信首次登录 ONES 时进行授权，拒绝授权将不会同步邮箱、地址等敏感字段数据。

[image: _6cGmfE4g; see source page]

启用「登录即时创建成员」后，新用户通过企业微信登录到系统时，会自动创建账号并同步用户数据。

注意：在「多团队」模式下，需要选择新用户默认加入的团队

#### 3.2.3 启用「消息通知」

启用「消息通知」可以允许已绑定企业微信账号的ONES用户在企业微信接收ONES消息通知，在【企业微信详情】>【消息通知】点击「启用」，即可开启消息通知。

注意：启用消息通知后，需要在「项目管理」、「知识库管理」等产品的配置中添加通知方式，具体可查看 [如何添加通知方式](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/5DiY3f3F)

[image: _t_XxSGYO; see source page]

### 3.3 移除集成

在【企业微信详情】点击「移除集成」，在确认弹窗输入“移除企业微信”即可移除集成，集成移除后，从企业微信获取的部门和已激活邮箱的用户将会保留，未激活邮箱的用户将会被清除。
