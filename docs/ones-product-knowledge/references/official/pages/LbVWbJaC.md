# API同步

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/LbVWbJaC
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 管理员手册 / 账号集成 / 第三方账号集成 / API同步
Evidence: documentation, not runtime verification

## API同步

## 1.功能入口

如果企业无法通过LDAP/AD标准协议、或系统支持的企业IM进行用户目录同步，可以配置API同步并通过企业提供的数据接口同步用户目录数据。管理员可在系统【团队配置中心】（多团队下【组织管理】）>【账号集成】页面，点击「添加账号集成」并选择「API同步」进行添加集成配置。

[image: image - 2024-04-26T163010.755.png; see source page]

## 2.配置步骤

### 2.1 添加API同步

#### 2.1.1 配置数据请求接口

在「添加API同步」，根据提示填写数据请求接口地址。

[image: image - 2024-04-26T163015.237.png; see source page]

企业接口需要按照以下内容定义接口返回数据

###### 企业接口返回数据说明

| 名称 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| 成员字段 | 成员字段 | 成员字段 | 成员字段 |
| userid | string | 是 | 唯一标识，字段名必须是userid，否则无法识别 |
| email | string | 是 | 邮箱，需要保证邮箱是企业唯一的 |
| name | string | 是 | 用户名，系统内显示的用户名称 |
| department | string[] | 否 | 部门，对应下方的部门ID，部门id为空则默认成员加到根部门 |
| id_number | string | 否 | 工号，需要保证工号是企业唯一的 |
| 部门字段 | 部门字段 | 部门字段 | 部门字段 |
| id | string | 是 | 部门唯一标识 |
| name | string | 是 | 部门名称 |
| parentid | string | 是 | 父部门的id，用于生成组织架构 |
| order | number | 是 | 部门显示的顺序 |

###### 示例数据：

```JSON
{

    "members":[

        {

            "userid":"xiaobaigou",

            "name":"xiaobaigou",

            "id_number":"8711",

            "department":[

                "corp-99672"

            ],

            "email":"xiaocai@ones.ai"

        },

        {

            "userid":"api_and_cas",

            "name":"lihao",

            "id_number":"8712",

            "department":[

                "corp-99672"

            ],

            "email":"api_and_csa@163.com"

        }

    ],

    "departments":[

        {

            "id":"corp-99672",

            "name":"研发组部",

            "parentid":"27001",

            "order":1

        },

        {

            "id":"27001",

            "name":"前台",

            "parentid":"0",

            "order":2

        }

    ]

}
```

#### 2.1.2 用户属性映射

设置上述的用户属性字段和系统属性字段的映射关系，目前系统支持同步的字段包含：用户名、邮箱、工号、公司、职位

注意：需要保证用户的邮箱、工号是企业唯一的

[image: wecom-temp-17b6cb2b9629b45707535222e0b401c0.png; see source page]

### 2.2 配置集成功能

添加集成后，进入【API同步详情】 可以选择是否启用「用户目录同步」。

#### 2.2.1 启用「用户目录同步」

启用「用户目录同步」可以同步企业用户目录。在【API同步详情】 > 【用户目录同步】页面，点击同步开关即可开启同步

- 定时同步：每10分钟ONES系统会从企业接口获取一次最新的成员和部门数据；

[image: image - 2024-04-26T163238.799.png; see source page]

### 2.3 移除集成

在【API同步详情】点击「移除集成」，在确认弹窗输入“移除API同步”即可移除集成，集成移除后，获取的部门和已激活邮箱的用户将会保留，未激活邮箱的用户将会被清除。
