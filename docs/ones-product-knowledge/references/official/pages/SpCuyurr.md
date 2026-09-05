# 短信服务接口定义

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/SpCuyurr
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 管理员手册 / 企业设置 / 手机号与短信服务设置 / 短信服务接口定义
Evidence: documentation, not runtime verification

## 短信服务接口定义

## 1.实现webhook连通性测试

为了保障数据安全，ONES 需要对 webhook 的连通性以及 token 的有效性进行验证。webhook 需要实现如下功能，以便保存 webhook 配置时进行验证。

调用方式：http/https

method: GET

query参数：echo_str=xxxxxxx

接口实现：echo_str 是一个 token 为秘钥，使用 AES-256-CBC 加密的密文字符串，webhook 需要对这段密文进行解密，回传给 ONES。

接口返回：echo_str 解密后的字符串。

## 2.按要求实现短信webhook

当 ONES 系统产生短信相关事件时，我们会按如下方式调用您所配置的短信 webhook ，您需要根据请求参数实现具体的发短信功能。

调用方式：http/https

method：POST

content-type：application/json

body：

```JSON
{

    "operation_user": "李华",

    "phone_numbers": "18812345678;18812345679",

    "message_type": "captcha",

    "summary": "标题",

    "action": "复制",

    "count": 3,

    "code": "123456",

    "timestamp": 1637739583,

    "sign": "90fbfcf15e74a36b89dbdb2a721d9aecffdfdddc5c83e27f7592594f71932481"

}
```

body参数说明：

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| operation_user | string | 操作者的名称 |
| phone_numbers | string | 接收方手机号列表，多个号码以“;”分隔。 |
| message_type | string | captcha：短信验证码，notice：工作项通知，remind：工作项提醒，workflow：工作流通知，wiki：wiki通知 |
| summary | string | 标题 |
| action | string | 批量触发类型：复制、新建、编辑 |
| count | number | 批量触发数量：为0时代表非批量 |
| code | string | 验证码 |
| timestamp | number | 消息产生时的unix时间戳。 |
| sign | string | 请求签名，验证方法见第二步。 |

## 3.验证签名

我们通过签名机制来防止请求的伪造或篡改。签名方法如下：

```JSON
# 先拼接签名字符串

paramString = "operation_user=李华&phone_numbers=18812345678;18812345679&message_type=captcha&summary=标题&action=复制&count=3&code=123456×tamp=1637739583&token=xxx"

# 加上token

signString = paramString+"&token=xxxxxxxx" # token为配置webhook时填写的

# hmac-256签名

sign = hash_hmac("sha256", signString, token) # token为配置webhook时填写的
```

在收到 webhook 的调用后，需要根据接收到的参数和签名算法再算一次签名值，然后和参数中的 sign 值匹配。如果两者一样，则验证通过，如果不一样，则应该阻止这个请求。
