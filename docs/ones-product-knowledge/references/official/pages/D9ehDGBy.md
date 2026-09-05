# 集成有度

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/D9ehDGBy
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 管理员手册 / 账号集成 / 第三方账号集成 / 集成有度
Evidence: documentation, not runtime verification

## 集成有度

## 1.功能入口

管理员可在系统「团队配置中心」（多团队下「组织管理」）>「账号集成」页面，点击「添加账号集成」并选择「有度」进行添加集成配置。

[image: image - 2024-05-15T150519.441.png; see source page]

## 2.配置步骤

### 2.1 添加有度

实现有度与ONES系统的集成，需要通过有度应用。在有度管理后台 ->【企业应用】中添加「自建应用」用以实现跟ONES 系统的集成。

[企业应用的开发流程](https://youdu.im/doc/api/c01_00001.html)

[image: image - 2024-05-15T150529.962.png; see source page]

#### 2.1.1 配置有度连接

在「添加有度」页面，按照提示填写 服务器地址 和 公司总机号。

[image: image - 2024-05-15T150548.895.png; see source page]

#### 2.1.2 填写应用信息

按照提示填写 App ID 和 EncodingAESKey。

[image: image - 2024-05-15T150600.929.png; see source page]

### 2.2 配置集成功能

添加集成后，进入【有度详情】 可以选择需要启用集成功能。

[image: image - 2024-05-15T150611.215.png; see source page]

#### 2.2.1 启用「消息通知」

启用「消息通知」可以让用户在「有度」接收系统消息通知，在【有度详情】>【消息通知】点击「启用」，即可开启消息通知。

注意：启用消息通知后，需要在「项目管理」、「知识库管理」等产品的配置中添加通知方式，具体可查看 [如何添加通知方式](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/5DiY3f3F)

[image: image - 2024-05-15T150623.381.png; see source page]

#### 2.2.2 绑定有度账号

完成有度配置与启用后，管理员可以通知团队成员在自己【账号详情】页面进行有度账号绑定操作。

[image: image - 2024-05-15T150633.062.png; see source page]

点击「绑定」后，在弹出的输入框中输入有度用户名进行绑定。有度用户与ONES 系统用户是一对一绑定关系，提交绑定的时候系统将自动检查：1.该有度用户名是否在有度服务中真实存在；2.该有度用户名是否已经绑定过某个ONES系统用户。若检查通过，即可成功绑定。

[image: image - 2024-05-15T150641.716.png; see source page]

系统管理员可以在系统中各通知设置功能勾选有度通知取到，勾选后当有对应消息产生，系统将自动通过有度通知对应用户，并支持点击打开对应详情页面链接。

[image: image - 2024-05-15T150651.828.png; see source page]
