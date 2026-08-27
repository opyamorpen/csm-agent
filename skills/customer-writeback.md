# 从客户沟通生成回写草稿

1. 使用当前会话已绑定的 CRM `customer_id`、客户名称、ONES 客户 option ID 和售后客户工时工作项 ID。缺少任何目标所需 ID 时停止，不得用模糊名称替代。
2. 只读取已确认归属到该客户的 Hemory 片段。摘录证据原文、发生时间和记录 ID；归属不明的录音不得用于回写。
3. 交互式 Agent 根据用户选择生成一种草稿。Hemory 自动草稿箱可从同一批片段生成多个有独立证据支持的类型：Agent 待办、建议、工单、工时或 CRM 跟进；不得生成无依据的空草稿。
4. ONES 新建建议/工单/运维工单前，先调用本地工具 `get_ones_desk_required_fields`（参数 record_type=suggestion/ticket/operations）获取该类型除标题/项目/类型外的全部必填字段契约：字段 fieldID、完整选项 label→UUID 表、兜底值与分类指引。`get_issue_fields` 会对大选项集（所属模块/所属产品）截断且部分选项 UUID 无效，不能用于枚举选项。草稿 fieldValues 必须携带每个规格字段的选项 UUID：`JrvswW8P`=当前客户 option ID（按「客户名称」`field_n1qN0__c__r` 或「售后客户名称」`field_83f4l__c` 精确唯一解析，解析失败时刷新客户同步，不做模糊归属），其余字段按返回的选项表与兜底值填写；实例部署类型必须用返回的"当前客户解析值"（CRM 使用版本=公有云版→公有云，其余→私有云），不得按沟通证据另选。确认因必填字段缺失被拒时，用 `get_ones_desk_required_fields` 补齐后重新 `confirm_write`。
5. 工时回写先调用 `get_manhour_mode`，只向当前客户的 `customer_manhour_issue_id` 登记；不创建新的“售后客户”工作项。
6. CRM 跟进写参数必须包含当前 CSM 售后客户 `_id`。若 CRM 工具只能绑定通用客户而不能绑定该记录，停止并说明字段契约缺口。
7. 调用 `confirm_write` 展示业务字段和完整 `target_arguments`。`fields` 必须包含 `customer_id`、`customer_name`、证据引用和未知项。
8. CSM 可编辑标题、摘要、业务字段和实际写参数；编辑后的参数重新绑定批准。批准后只调用获批的同一工具和参数。
9. Hemory 自动草稿中的待办确认后只创建本地 `action_items`，不调用企业微信。批量批准按草稿逐项执行，失败项保留原始错误并单独重试。
