/**
 * 由 scripts/gen-api.mjs 自动生成（openapi-typescript）。
 * 请勿手改；后端接口变更后运行 pnpm gen:api 重新生成。
 */
export interface paths {
    "/api/v1/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Login */
        post: operations["login_api_v1_auth_login_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Refresh
         * @description 无状态刷新：验 Cookie 里的 refresh JWT（typ 校验在 decode_refresh_token 里，
         *     access 令牌到这里必 401），换发新 access 并**轮换** refresh Cookie。
         *     无状态 ⇒ logout 不能撤销已签发的 refresh（限制全文见 security.create_refresh_token）。
         */
        post: operations["refresh_api_v1_auth_refresh_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Logout
         * @description 登出：清 refresh Cookie。无状态令牌本体无法吊销（限制见 security.create_refresh_token），
         *     这里做的是「让本浏览器不再能刷新」，不是服务端撤销。
         */
        post: operations["logout_api_v1_auth_logout_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Me */
        get: operations["me_api_v1_auth_me_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/roles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Roles */
        get: operations["roles_api_v1_roles_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Projects */
        get: operations["list_projects_api_v1_projects_get"];
        put?: never;
        /** Create Project */
        post: operations["create_project_api_v1_projects_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{project_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Project */
        get: operations["get_project_api_v1_projects__project_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update Project */
        patch: operations["update_project_api_v1_projects__project_id__patch"];
        trace?: never;
    };
    "/api/v1/projects/{project_id}/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Members */
        get: operations["list_members_api_v1_projects__project_id__members_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{project_id}/members/{user_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Set Member */
        put: operations["set_member_api_v1_projects__project_id__members__user_id__put"];
        post?: never;
        /** Remove Member */
        delete: operations["remove_member_api_v1_projects__project_id__members__user_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/agent/tools": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Agent Tools
         * @description 工具元数据（§12.3 试验台）：与 Agent 可见性同一过滤器，READONLY 成员不见写工具。
         */
        get: operations["list_agent_tools_api_v1_agent_tools_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/agent/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create Session */
        post: operations["create_session_api_v1_agent_sessions_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/agent/sessions/{session_id}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Messages */
        get: operations["get_messages_api_v1_agent_sessions__session_id__messages_get"];
        put?: never;
        /** Post Message */
        post: operations["post_message_api_v1_agent_sessions__session_id__messages_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/agent/sessions/{session_id}/interrupt": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Interrupt */
        post: operations["interrupt_api_v1_agent_sessions__session_id__interrupt_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/events/agent/{session_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Events */
        get: operations["events_api_v1_events_agent__session_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/events/run/{run_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Run Events */
        get: operations["run_events_api_v1_events_run__run_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/api-cases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出接口用例（默认不含回收站；recycled=true 只看已回收） */
        get: operations["get_api_case_list_api_v1_api_cases_get"];
        put?: never;
        /** 在接口定义下创建用例（request 为按键覆盖层，缺省=完全继承定义；assertions 追加在定义断言后；可绑数据集） */
        post: operations["post_api_case_create_api_v1_api_cases_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/api-cases/{case_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 获取用例详情（含 effective_request 合并结果） */
        get: operations["get_api_case_get_api_v1_api_cases__case_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 更新用例（request 覆盖层按键合并进已存覆盖；assertions 整体替换；dataset_set=true 才动数据集，可解绑传 null） */
        patch: operations["patch_api_case_update_api_v1_api_cases__case_id__patch"];
        trace?: never;
    };
    "/api/v1/api-cases/{case_id}/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 把用例放入回收站（软删；已回收再删 404；被未回收场景引用时 409 并列出引用者，确认要连带断掉这些步骤才带 force） */
        post: operations["post_api_case_delete_api_v1_api_cases__case_id__delete_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/api-cases/{case_id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 从回收站恢复用例 */
        post: operations["post_api_case_restore_api_v1_api_cases__case_id__restore_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/api-cases/{case_id}/purge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 彻底删除回收站中的用例（物理删除，不可恢复） */
        post: operations["post_api_case_purge_api_v1_api_cases__case_id__purge_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/datasets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出项目数据集（含列头与全量行数据） */
        get: operations["get_data_set_list_api_v1_datasets_get"];
        put?: never;
        /** 创建数据集（columns 列头 + rows 二维数组；每行长度必须等于列数；name 项目内唯一） */
        post: operations["post_data_set_create_api_v1_datasets_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/datasets/{dataset_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 整表覆盖数据集（columns/rows 全量替换——表格编辑器保存即调它） */
        patch: operations["patch_data_set_update_api_v1_datasets__dataset_id__patch"];
        trace?: never;
    };
    "/api/v1/datasets/{dataset_id}/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 删除数据集（被未回收用例引用时 409，先解绑或回收用例；用例即使已回收，只要它还被未回收场景引用也 409） */
        post: operations["post_data_set_delete_api_v1_datasets__dataset_id__delete_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/api-import-preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 导入向导步骤②：解析 OpenAPI3/Swagger2/Postman 并与现有接口做冲突比对（method+归一路径；解析错误进 errors 人话列表，不抛） */
        post: operations["post_api_import_preview_api_v1_api_import_preview_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/api-import-commit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 导入向导步骤③：整批一事务落库（任一失败 = 不 commit，整批回滚）；冲突按逐条策略 跳过/覆盖（D26 无「新版本」），覆盖 diff 进审计 */
        post: operations["post_api_import_commit_api_v1_api_import_commit_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/api-export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 导出备份（1E T5）：勾选/全量接口 → OpenAPI3 文档（§7.1 逆映射，可被导入向导原样吃回——往返自证）；读类动作故 perm 以 :read 结尾（POST 不影响 READONLY glob）；Postman 导出不做（未覆盖如实报） */
        post: operations["post_api_export_api_v1_api_export_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/api-modules": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 整棵接口模块树（默认不含回收站；include_recycled=true 时 recycled 数组返回回收根节点） */
        get: operations["get_api_module_tree_api_v1_api_modules_get"];
        put?: never;
        /** 新建接口模块（同父重名 409） */
        post: operations["post_api_module_create_api_v1_api_modules_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/api-modules/{module_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 改名/排序/移动模块（parent_id 显式传入即移动，null=移到根；成环 400） */
        patch: operations["patch_api_module_update_api_v1_api_modules__module_id__patch"];
        trace?: never;
    };
    "/api/v1/api-modules/{module_id}/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 把模块连子孙放入回收站（软删；接口不删，恢复后原样回归） */
        post: operations["post_api_module_delete_api_v1_api_modules__module_id__delete_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/api-modules/{module_id}/purge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 彻底删除回收站中的模块（连子孙一起物理删除；其下接口改为未分类，不连带删除；不可恢复） */
        post: operations["post_api_module_purge_api_v1_api_modules__module_id__purge_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/api-modules/{module_id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 从回收站恢复模块（子孙一并回归） */
        post: operations["post_api_module_restore_api_v1_api_modules__module_id__restore_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 分页查询运行记录（列表不带响应体；过滤 subject_id/subject_type/trigger/status） */
        get: operations["get_run_record_list_api_v1_runs_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/runs/{run_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 单条运行记录详情（含请求/响应快照与断言明细） */
        get: operations["get_run_get_api_v1_runs__run_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/api-definitions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出项目下的 API 接口定义（filter 传高级搜索条件 JSON：{search_mode: AND|OR, conditions: [{field, operator, value}]}，可筛字段与操作符见 /filter-meta?view_type=api） */
        get: operations["get_api_definition_list_api_v1_api_definitions_get"];
        put?: never;
        /** 创建 API 接口定义（request 为 §7.1 请求对象；name+project 唯一） */
        post: operations["post_api_definition_create_api_v1_api_definitions_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/api-definitions/{definition_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 获取单个 API 接口定义 */
        get: operations["get_api_definition_get_api_v1_api_definitions__definition_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 更新 API 接口定义（乐观锁：version 不匹配 → 409 conflict） */
        patch: operations["patch_api_definition_update_api_v1_api_definitions__definition_id__patch"];
        trace?: never;
    };
    "/api/v1/api-definitions/{definition_id}/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 接口定义放入回收站（软删；用例不删，随定义整体不可达，restore 原样回归；其未回收用例被未回收场景引用时 409 并列出引用者，确认要连带断掉这些步骤才带 force） */
        post: operations["post_api_definition_delete_api_v1_api_definitions__definition_id__delete_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/api-definitions/{definition_id}/purge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 彻底删除回收站中的接口定义（物理删除，连带其用例；接口名随之释放，不可恢复） */
        post: operations["post_api_definition_purge_api_v1_api_definitions__definition_id__purge_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/api-definitions/{definition_id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 从回收站恢复接口定义 */
        post: operations["post_api_definition_restore_api_v1_api_definitions__definition_id__restore_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/api-debug": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 单接口调试：真实发送请求并评估断言（对目标系统有外部副作用；返回全量响应与断言明细） */
        post: operations["post_api_debug_api_v1_api_debug_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 查询审计日志（入口 http/agent/schedule + 动作 + 成败 + 时间区间筛选；最新在前） */
        get: operations["get_audit_list_api_v1_audit_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/envs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出项目下的测试环境 */
        get: operations["get_env_list_api_v1_envs_get"];
        put?: never;
        /** 在项目中创建测试环境（含 base_url 等变量，S0 仅存储） */
        post: operations["post_env_create_api_v1_envs_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/envs/{env_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** 删除测试环境（不可逆；被场景/UI 用例/定时任务引用时 409 列出引用） */
        delete: operations["delete_env_delete_api_v1_envs__env_id__delete"];
        options?: never;
        head?: never;
        /** 修改测试环境（名称/顺序/变量） */
        patch: operations["patch_env_update_api_v1_envs__env_id__patch"];
        trace?: never;
    };
    "/api/v1/envs/global-config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 读取项目级全局配置（变量/请求头/断言/提取四类作用域） */
        get: operations["get_global_config_get_api_v1_envs_global_config_get"];
        put?: never;
        /** 覆盖式保存某一作用域的全局配置（整段提交，不做增量合并） */
        post: operations["post_global_config_update_api_v1_envs_global_config_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/artifacts/{run_id}/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 下载运行制品原始字节（响应体快照/日志/截图；报告页制品入口） */
        get: operations["get_artifact_download_api_v1_artifacts__run_id___name__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/reports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 报告中心列表：时间/场景/对象类型/触发/执行人/环境/结果筛选，默认不含调试运行 */
        get: operations["get_report_list_api_v1_reports_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/reports/{run_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 报告详情：概要 + summary_graph 快照 + 步骤摘要（数据集步带 pass_rows/total_rows）+ 制品 */
        get: operations["get_report_get_api_v1_reports__run_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/reports/{run_id}/steps": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 报告步骤明细：步骤 detail（request/response/断言/logs）+ vars_snapshot；response body/logs 超阈值时以 head + 制品 ref 替身呈现，未超阈值原样返回 */
        get: operations["get_report_step_detail_api_v1_reports__run_id__steps_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/project-member-candidates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 按账号/姓名在项目范围内查找可添加为用户（返回 id/account/name/is_member，不含平台字段） */
        get: operations["get_project_member_candidates_api_v1_project_member_candidates_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/system/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 分页列出平台用户（仅系统管理员可见） */
        get: operations["get_user_list_api_v1_system_users_get"];
        put?: never;
        /** 创建平台用户（仅系统管理员；密码只存哈希） */
        post: operations["post_user_create_api_v1_system_users_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/system/users/{user_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 修改用户资料或重置密码（仅系统管理员；审计不落密码） */
        patch: operations["patch_user_update_api_v1_system_users__user_id__patch"];
        trace?: never;
    };
    "/api/v1/system/users/{user_id}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 启用/禁用平台用户（禁用即刻生效：登录拒绝且旧 token 失效） */
        post: operations["post_user_status_api_v1_system_users__user_id__status_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 修改自己的登录密码（任何认证用户；需提供旧密码） */
        post: operations["post_password_change_self_api_v1_auth_password_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/role-templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出内置角色模板（成员管理下拉数据源；任何认证用户可见） */
        get: operations["get_role_template_list_api_v1_role_templates_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/system/users/import-preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** D40 批量导入步骤①：解析粘贴的 CSV/TSV（账号/姓名/邮箱，制表符优先逗号兜底）并与现有账号做冲突比对；格式错误收成带行号的人话进 errors，不抛 */
        post: operations["post_user_import_preview_api_v1_system_users_import_preview_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/system/users/import-commit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** D40 批量导入步骤②：逐行建用户（1E T4 口径的冲突逐条跳过 + 报告）——冲突/非法行逐条跳过并给「第几行为什么」，有效行照建；只有落库层故障才整批回滚。审计记产出行（复用 T4 的 produced 形状），绝不记初始密码 */
        post: operations["post_user_import_commit_api_v1_system_users_import_commit_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/custom-roles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出自定义角色（项目内；内置四枚模板走 /role-templates 目录，不在此列） */
        get: operations["get_role_custom_list_api_v1_custom_roles_get"];
        put?: never;
        /** 从内置模板复制创建自定义角色（perms 省略 = 模板位原样快照；传了 perms = 在权限菜单树上裁剪后的完整位集，任意裁剪任意勾选按计划假设 4） */
        post: operations["post_role_create_api_v1_custom_roles_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/custom-roles/{code}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 修改自定义角色（名称/权限位整体替换）。内置角色 403：内置位动了，权限矩阵那张 116 格表就失去意义（D37 假设 3） */
        patch: operations["patch_role_update_api_v1_custom_roles__code__patch"];
        trace?: never;
    };
    "/api/v1/custom-roles/{code}/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 删除自定义角色（被任何项目成员引用时 409 带引用计数；内置角色 403） */
        post: operations["post_role_delete_api_v1_custom_roles__code__delete_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/role-perm-tree": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 两级权限菜单树：REGISTRY.perm_points() 的运行时投影（前缀族一级、完整权限位二级）+ 内置模板位快照。新增权限位自动出现——前端硬编码一棵树就是第二道假门 */
        get: operations["get_role_perm_tree_api_v1_role_perm_tree_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/model-cfgs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出已登记的模型（api_key 打码回显；全局共享池） */
        get: operations["get_model_cfg_list_api_v1_model_cfgs_get"];
        put?: never;
        /** 登记一个模型服务（OpenAI 兼容/Anthropic），api_key 将加密保存 */
        post: operations["post_model_cfg_create_api_v1_model_cfgs_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/model-cfgs/{cfg_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** 删除模型（仅系统管理员） */
        delete: operations["delete_model_cfg_delete_api_v1_model_cfgs__cfg_id__delete"];
        options?: never;
        head?: never;
        /** 修改模型配置；api_key 留空表示保留原密钥 */
        patch: operations["patch_model_cfg_update_api_v1_model_cfgs__cfg_id__patch"];
        trace?: never;
    };
    "/api/v1/model-cfgs/{cfg_id}/probe": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 逐能力真探（§6.8）：连通 + tools/thinking/vision 逐项探测回填能力位；EMBEDDING 走 embed(ping) 回填 embed_dimensions；含糊态标 unknown 不改存储值 */
        post: operations["post_model_cfg_probe_api_v1_model_cfgs__cfg_id__probe_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenario-export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 导出备份（D74，§11.4.8 批量条）：勾选/全量场景 → 只读快照 JSON（step_graph 逐字 + 保存期同口径 validate 判定 + 引用原样 id 指针；读类动作故 perm 以 :read 结尾；**只读导出不可回灌**——场景域无导入解析器，如实报，不假装往返） */
        post: operations["post_scenario_export_api_v1_scenario_export_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenario-modules": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 整棵场景模块树（默认不含回收站；include_recycled=true 时 recycled 数组返回回收根节点） */
        get: operations["get_scenario_module_tree_api_v1_scenario_modules_get"];
        put?: never;
        /** 新建场景模块（同父重名 409；根层重名同样 409——MySQL 唯一键不判等 NULL，根层由服务层自查） */
        post: operations["post_scenario_module_create_api_v1_scenario_modules_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenario-modules/{module_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 改名/排序/移动场景模块（parent_id 显式传入即移动，null=移到根；成环 400） */
        patch: operations["patch_scenario_module_update_api_v1_scenario_modules__module_id__patch"];
        trace?: never;
    };
    "/api/v1/scenario-modules/{module_id}/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 把场景模块连子孙放入回收站（软删；场景不删，恢复后原样回归） */
        post: operations["post_scenario_module_delete_api_v1_scenario_modules__module_id__delete_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenario-modules/{module_id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 从回收站恢复场景模块（子孙一并回归） */
        post: operations["post_scenario_module_restore_api_v1_scenario_modules__module_id__restore_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenario-modules/{module_id}/purge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 彻底删除回收站中的场景模块（连子孙一起物理删除；其下场景改为未分类，不连带删除；不可恢复） */
        post: operations["post_scenario_module_purge_api_v1_scenario_modules__module_id__purge_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenarios": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出项目下的场景（默认不含回收站；recycled=true 只看已回收；最近结果来自冗余列，不 N+1 查运行记录） */
        get: operations["get_scenario_list_api_v1_scenarios_get"];
        put?: never;
        /** 创建场景（step_graph 过 step_graph 协议校验：有 issue → 422 validation_error + details.issues；同项目重名 409） */
        post: operations["post_scenario_create_api_v1_scenarios_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenarios/{scenario_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 获取场景详情（含 live issues：打开老场景即能看见校验问题，不必等保存报错） */
        get: operations["get_scenario_get_api_v1_scenarios__scenario_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 更新场景（乐观锁：version 不匹配 → 409 conflict + details.current_version；成功则 version+=1、重算 step_count、记 updated_by） */
        patch: operations["patch_scenario_update_api_v1_scenarios__scenario_id__patch"];
        trace?: never;
    };
    "/api/v1/scenarios/{scenario_id}/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 把场景放入回收站（软删；已回收再删 404） */
        post: operations["post_scenario_delete_api_v1_scenarios__scenario_id__delete_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenarios/{scenario_id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 从回收站恢复场景 */
        post: operations["post_scenario_restore_api_v1_scenarios__scenario_id__restore_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenarios/{scenario_id}/purge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 彻底删除回收站中的场景（物理删除，不可恢复；须逐字确认场景名） */
        post: operations["post_scenario_purge_api_v1_scenarios__scenario_id__purge_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenarios/{scenario_id}/duplicate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 复制场景（step_graph/variables/priority 原样；新场景名默认加「- 副本」后缀，可覆盖） */
        post: operations["post_scenario_duplicate_api_v1_scenarios__scenario_id__duplicate_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenario-batch-move": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 批量移动场景到某模块（module_id=None 移到根/未分类；回收站中的场景被拒 404） */
        post: operations["post_scenario_batch_move_api_v1_scenario_batch_move_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenario-references": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 查引用某用例/接口定义的未回收场景（含命中步骤 key 列表；供接口详情「场景引用」Tab） */
        get: operations["get_scenario_references_api_v1_scenario_references_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenarios/{scenario_id}/run": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 执行场景：建 queued run 并投递给 worker（inline 档为同进程协程）；trigger 由入口自动决定（HTTP=manual，Agent=agent），调用方不可自选 */
        post: operations["post_scenario_run_api_v1_scenarios__scenario_id__run_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenarios/{scenario_id}/debug": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 调试场景：跑**传入**的 step_graph（未保存也许可 debug，§11.5.6）；trigger=debug，图随 run 行快照自包含，不回写「最近结果」 */
        post: operations["post_scenario_debug_api_v1_scenarios__scenario_id__debug_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/runs/{run_id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 取消执行中的 run：置取消旗（步骤边界生效，§8.2）；已完成步骤保留可读 */
        post: operations["post_run_cancel_api_v1_runs__run_id__cancel_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/runs/{run_id}/rerun-step": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 单步重跑：从来源 run 的落库快照重建上下文只跑该步（§8.3）；同步等待，响应即终态；明细缺失 409 snapshot_missing */
        post: operations["post_run_rerun_step_api_v1_runs__run_id__rerun_step_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/search-assets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 全局快捷查找：按名称/路径关键词搜接口定义、用例、场景、元素、UI 用例、ADB 用例、定时任务、通知渠道（Ctrl+K，§11.4.19；一期 MySQL LIKE，§9.10） */
        get: operations["get_search_assets_api_v1_search_assets_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/filter-meta": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出高级搜索支持的操作符、各字段类型可用的子集，以及指定列表页可筛的字段（前端筛选表单的唯一真相，不在前端另抄一份） */
        get: operations["get_filter_meta_api_v1_filter_meta_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/saved-views": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出本项目本页面上我保存的筛选视图（个人视图，同项目别人看不到） */
        get: operations["get_saved_view_list_api_v1_saved_views_get"];
        put?: never;
        /** 把当前筛选存成个人视图 */
        post: operations["post_saved_view_create_api_v1_saved_views_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/saved-views/{view_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** 删除个人视图（只删自己的；视图不挂任何引用，删了不影响任何资产） */
        delete: operations["delete_saved_view_delete_api_v1_saved_views__view_id__delete"];
        options?: never;
        head?: never;
        /** 改个人视图的名称或筛选条件 */
        patch: operations["patch_saved_view_update_api_v1_saved_views__view_id__patch"];
        trace?: never;
    };
    "/api/v1/plans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出本项目的测试计划（页码分页；未归档与已归档都在列表里，archived 是列不是筛选） */
        get: operations["get_plan_list_api_v1_plans_get"];
        put?: never;
        /** 在项目中创建测试计划（同项目重名 409；新建即未归档的项目级共享计划） */
        post: operations["post_plan_create_api_v1_plans_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/plans/{plan_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 获取计划详情（跨项目与不存在同码同文案） */
        get: operations["get_plan_get_api_v1_plans__plan_id__get"];
        put?: never;
        post?: never;
        /** 删除计划（物理删，无回收站，不可逆；同事务级联删该计划的关联行） */
        delete: operations["delete_plan_delete_api_v1_plans__plan_id__delete"];
        options?: never;
        head?: never;
        /** 修改计划名称/描述（**改不了归档**——归档走 /plans/{plan_id}/archive，:manage） */
        patch: operations["patch_plan_update_api_v1_plans__plan_id__patch"];
        trace?: never;
    };
    "/api/v1/plans/{plan_id}/archive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 归档计划（终态、单向门：MEMBER 被 -*:manage 拒绝，只剩项目管理员及以上；没有反归档端点） */
        post: operations["post_plan_archive_api_v1_plans__plan_id__archive_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/plans/{plan_id}/case-links": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出计划的关联行（页码分页；执行结论不在这里——join run_record 现算归步 3） */
        get: operations["get_plan_link_list_api_v1_plans__plan_id__case_links_get"];
        put?: never;
        /** 把可执行用例挂进计划（四种 subject；同计划重复挂 409；env 能抄就抄、传了先验归属） */
        post: operations["post_plan_link_create_api_v1_plans__plan_id__case_links_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/plans/{plan_id}/case-links/{link_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** 把用例从计划里摘除（只删关联行，对象本身毫发无损——摘挂不是删用例） */
        delete: operations["delete_plan_link_delete_api_v1_plans__plan_id__case_links__link_id__delete"];
        options?: never;
        head?: never;
        /** 改关联行的执行环境（**只改 env**：换 subject 是删了重挂；clear_env 显式清空） */
        patch: operations["patch_plan_link_update_api_v1_plans__plan_id__case_links__link_id__patch"];
        trace?: never;
    };
    "/api/v1/plans/{plan_id}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 计划实时状态现算（未开始/进行中/已完成/归档 + 通过率/执行率；queued/running 算执行中不算已执行，两个率的分母都是用例总数；不落库） */
        get: operations["get_plan_status_api_v1_plans__plan_id__status_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/plans/{plan_id}/reports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列计划的报告（页码分页；行 = 报告头不带明细——列表不为每行明细付查询） */
        get: operations["get_plan_report_list_api_v1_plans__plan_id__reports_get"];
        put?: never;
        /** 生成计划报告（一次性快照：抄计划名/展示态/计数/逐关联结论进 report+item，此后用例怎么改、再执行多少次都不动已生成的报告；与实时状态同一套口径与同一份取数） */
        post: operations["post_plan_report_create_api_v1_plans__plan_id__reports_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/plan-reports/{report_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 读报告（详情 = 头 + 全量明细；纯读存量副本，**零现算零 join**——「读取路径改成现算」是本刀变异自证点名要杀的形状。步 5 起本端点形状**不许改**：快照逐字节用例比的就是这里的 body 逐字节相等，明细分页走 GET /plan-reports/{report_id}/items，不是给这里塞 current） */
        get: operations["get_plan_report_get_api_v1_plan_reports__report_id__get"];
        put?: never;
        post?: never;
        /** 删除报告（物理删；同事务级联删该报告的明细行——只按 report_id 删，别的报告的明细一根毫毛不许动） */
        delete: operations["delete_plan_report_delete_api_v1_plan_reports__report_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/plan-reports/{report_id}/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 报告明细分页（页码制，D47-b 口径与 plan_report_list 同尺：只做页码不挂 cursor；行 = 明细副本原样，零现算零 join，序 = link_id 升序 = 详情 items 同一个序） */
        get: operations["get_plan_report_item_list_api_v1_plan_reports__report_id__items_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ui-modules": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 整棵 UI 模块树（默认不含回收站；include_recycled=true 时 recycled 数组返回回收根节点）；count=直属未回收元素+用例，element_count/case_count 分开给 */
        get: operations["get_ui_module_tree_api_v1_ui_modules_get"];
        put?: never;
        /** 新建 UI 模块（同父重名 409；根层重名同样 409——MySQL 唯一键不判等 NULL，根层由服务层自查） */
        post: operations["post_ui_module_create_api_v1_ui_modules_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ui-modules/{module_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 改名/排序/移动 UI 模块（parent_id 显式传入即移动，null=移到根；成环 400） */
        patch: operations["patch_ui_module_update_api_v1_ui_modules__module_id__patch"];
        trace?: never;
    };
    "/api/v1/ui-modules/{module_id}/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 把 UI 模块连子孙放入回收站（软删；元素与用例都不删，恢复后原样回归） */
        post: operations["post_ui_module_delete_api_v1_ui_modules__module_id__delete_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ui-modules/{module_id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 从回收站恢复 UI 模块（子孙一并回归） */
        post: operations["post_ui_module_restore_api_v1_ui_modules__module_id__restore_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ui-modules/{module_id}/purge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 彻底删除回收站中的 UI 模块（连子孙一起物理删除；其下元素与用例改为未分类，不连带删除；不可恢复；须逐字确认模块名） */
        post: operations["post_ui_module_purge_api_v1_ui_modules__module_id__purge_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ui-elements": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出项目下的元素（默认不含回收站；recycled=true 只看已回收；used_by=未回收 UI 用例引用数，与删除拦截同源，批量一次算不 N+1） */
        get: operations["get_ui_element_list_api_v1_ui_elements_get"];
        put?: never;
        /** 新建元素（同项目重名含回收站墓碑 → 409 name_exists；定位器类型限 5 种，R100/D2） */
        post: operations["post_ui_element_create_api_v1_ui_elements_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ui-elements/{element_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 获取元素详情（回收站中的元素 404；used_by 与删除拦截同源） */
        get: operations["get_ui_element_get_api_v1_ui_elements__element_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 改元素（改名/定位器/备注/移动模块/可见性）。**有引用时改 locator_type 或 locator → 409 referenced_by_case**：用例的 steps 不存定位器副本，改了等于静默改写别人的用例 */
        patch: operations["patch_ui_element_update_api_v1_ui_elements__element_id__patch"];
        trace?: never;
    };
    "/api/v1/ui-elements/{element_id}/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 把元素放入回收站（软删；被未回收 UI 用例引用 → 409 referenced_by_case + 用例清单，R106） */
        post: operations["post_ui_element_delete_api_v1_ui_elements__element_id__delete_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ui-elements/{element_id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 从回收站恢复元素（同名已被别人占走 → 409 name_exists，不静默改名） */
        post: operations["post_ui_element_restore_api_v1_ui_elements__element_id__restore_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ui-elements/{element_id}/purge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 彻底删除回收站中的元素（物理删除；被引用同样硬拦；须逐字确认元素名） */
        post: operations["post_ui_element_purge_api_v1_ui_elements__element_id__purge_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ui-cases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出项目下的 UI 用例（默认不含回收站；§11.5.4 六列的最近结果读冗余列，不 N+1 查 run_record） */
        get: operations["get_ui_case_list_api_v1_ui_cases_get"];
        put?: never;
        /** 创建 UI 用例（steps 过 §7.2 协议校验 + 元素引用完整性：不过 → 422；同项目重名 409） */
        post: operations["post_ui_case_create_api_v1_ui_cases_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ui-cases/{case_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 获取 UI 用例详情（含 live issues：打开老用例就看得见校验问题，不必等保存 422） */
        get: operations["get_ui_case_get_api_v1_ui_cases__case_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 更新 UI 用例（改 steps 时重过两道门并重算 step_count；无乐观锁，R104 与 ApiCase 对齐） */
        patch: operations["patch_ui_case_update_api_v1_ui_cases__case_id__patch"];
        trace?: never;
    };
    "/api/v1/ui-cases/{case_id}/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 把 UI 用例放入回收站（软删；已回收再删 404；被未回收场景引用时 409 并列出引用者，确认要连带断掉这些步骤才带 force） */
        post: operations["post_ui_case_delete_api_v1_ui_cases__case_id__delete_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ui-cases/{case_id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 从回收站恢复 UI 用例（回收期间名字被占 → 409，不静默改名） */
        post: operations["post_ui_case_restore_api_v1_ui_cases__case_id__restore_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ui-cases/{case_id}/purge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 彻底删除回收站中的 UI 用例（物理删除，不可恢复；须逐字确认用例名） */
        post: operations["post_ui_case_purge_api_v1_ui_cases__case_id__purge_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ui-case-references": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 查引用这条 UI 用例的未回收场景（含命中步骤 key；供用例详情「场景引用」Tab） */
        get: operations["get_ui_case_references_api_v1_ui_case_references_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ui-cases/{case_id}/debug": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 调试 UI 用例：进程内真跑 Playwright（不投 worker），落调试 run + 逐命令明细 + 制品；不回写用例「最近结果」；返回 UI 形状调试载荷 */
        post: operations["post_ui_case_debug_api_v1_ui_cases__case_id__debug_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ui-cases/{case_id}/run": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 执行 UI 用例：投 worker（trigger=manual，R42 按名字投递）；broker 不可达 503 且不留 queued 孤儿；返回 queued 的 run_id */
        post: operations["post_ui_case_run_api_v1_ui_cases__case_id__run_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-modules": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 整棵 ADB 模块树（默认不含回收站；include_recycled=true 时 recycled 数组返回回收根节点）；count=直属未回收 ADB 用例数 */
        get: operations["get_adb_module_tree_api_v1_adb_modules_get"];
        put?: never;
        /** 新建 ADB 模块（同父重名 409；根层重名同样 409——MySQL 唯一键不判等 NULL，根层由服务层自查） */
        post: operations["post_adb_module_create_api_v1_adb_modules_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-modules/{module_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 改名/排序/移动 ADB 模块（parent_id 显式传入即移动，null=移到根；成环 400） */
        patch: operations["patch_adb_module_update_api_v1_adb_modules__module_id__patch"];
        trace?: never;
    };
    "/api/v1/adb-modules/{module_id}/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 把 ADB 模块连子孙放入回收站（软删；用例不删，恢复后原样回归） */
        post: operations["post_adb_module_delete_api_v1_adb_modules__module_id__delete_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-modules/{module_id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 从回收站恢复 ADB 模块（子孙一并回归） */
        post: operations["post_adb_module_restore_api_v1_adb_modules__module_id__restore_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-modules/{module_id}/purge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 彻底删除回收站中的 ADB 模块（连子孙一起物理删除；其下用例改为未分类，不连带删除；不可恢复；须逐字确认模块名） */
        post: operations["post_adb_module_purge_api_v1_adb_modules__module_id__purge_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-cases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出项目下的 ADB 用例（默认不含回收站；最近结果读冗余列，不 N+1 查 run_record） */
        get: operations["get_adb_case_list_api_v1_adb_cases_get"];
        put?: never;
        /** 创建 ADB 用例（steps 过 §7.3 协议校验：不过 → 422 逐行 issues；同项目重名 409） */
        post: operations["post_adb_case_create_api_v1_adb_cases_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-cases/{case_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 获取 ADB 用例详情（含 live issues：打开老用例就看得见校验问题，不必等保存 422） */
        get: operations["get_adb_case_get_api_v1_adb_cases__case_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 更新 ADB 用例（改 steps 时重过协议门并重算 step_count；无乐观锁，R104 同 UiCase） */
        patch: operations["patch_adb_case_update_api_v1_adb_cases__case_id__patch"];
        trace?: never;
    };
    "/api/v1/adb-cases/{case_id}/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 把 ADB 用例放入回收站（软删；已回收再删 404；被未回收场景引用时 409 并列出引用者，确认要连带断掉这些步骤才带 force） */
        post: operations["post_adb_case_delete_api_v1_adb_cases__case_id__delete_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-cases/{case_id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 从回收站恢复 ADB 用例（回收期间名字被占 → 409，不静默改名） */
        post: operations["post_adb_case_restore_api_v1_adb_cases__case_id__restore_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-cases/{case_id}/purge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 彻底删除回收站中的 ADB 用例（物理删除，不可恢复；须逐字确认用例名） */
        post: operations["post_adb_case_purge_api_v1_adb_cases__case_id__purge_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-case-references": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 查引用这条 ADB 用例的未回收场景（含命中步骤 key；供用例详情「场景引用」Tab） */
        get: operations["get_adb_case_references_api_v1_adb_case_references_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-cases/{case_id}/debug": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 调试 ADB 用例：进程内真跑（不投 worker），落调试 run + 逐步明细 + 制品；必选空闲设备（占用 422 device_occupied，绝不排队）；不回写「最近结果」 */
        post: operations["post_adb_case_debug_api_v1_adb_cases__case_id__debug_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-cases/{case_id}/run": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 执行 ADB 用例：投 worker（trigger=manual，R42 按名字投递）；broker 不可达 503 且不留 queued 孤儿；指定设备忙则 FIFO 排队（位次走 device_queued 事件），返回 queued 的 run_id */
        post: operations["post_adb_case_run_api_v1_adb_cases__case_id__run_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出项目下的 ADB 设备（默认不含回收站；last_state 是最新心跳帧；state=offline/occupied/idle 按卡片三档筛选、每行带占用读数、页码模式报真 total） */
        get: operations["get_adb_device_list_api_v1_adb_devices_get"];
        put?: never;
        /** 创建 ADB 设备（先 adb connect 验证再入库：连不上 → 422 排错提示；成功才 201） */
        post: operations["post_adb_device_create_api_v1_adb_devices_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-devices/{device_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 获取单个 ADB 设备 */
        get: operations["get_adb_device_get_api_v1_adb_devices__device_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 更新 ADB 设备浅字段（name/enabled/可见性；改 serial/connect_type 用测试连接端点重验） */
        patch: operations["patch_adb_device_update_api_v1_adb_devices__device_id__patch"];
        trace?: never;
    };
    "/api/v1/adb-devices/{device_id}/occupation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 读取设备占用快照（谁在占用/几人在排队）——卡片墙「占用/排队」与执行前的空闲判定 */
        get: operations["get_adb_device_occupation_api_v1_adb_devices__device_id__occupation_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-devices/{device_id}/force-release": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 强制释放被占用的设备（管理员，D16）：删锁 + 清队；被释放的原持有者此后不再能续期/释放 */
        post: operations["post_adb_device_force_release_api_v1_adb_devices__device_id__force_release_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-devices/{device_id}/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 测试连接设备：adb connect + getprop 原样回显 + 截一张 screencap 缩略图（bytes→base64）；不写库，卡片墙「测试连接」按钮 */
        post: operations["post_adb_device_test_api_v1_adb_devices__device_id__test_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-devices/{device_id}/reconnect": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 重连设备：adb disconnect 后重连，刷新 last_state（§6.4 断开/重连） */
        post: operations["post_adb_device_reconnect_api_v1_adb_devices__device_id__reconnect_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-devices/{device_id}/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 把 ADB 设备放入回收站（软删；被 adb_case 引用时仍可删——default_device 变 unbound，执行时 tell；硬拦留在 purge） */
        post: operations["post_adb_device_delete_api_v1_adb_devices__device_id__delete_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-devices/{device_id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 从回收站恢复 ADB 设备 */
        post: operations["post_adb_device_restore_api_v1_adb_devices__device_id__restore_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/adb-devices/{device_id}/purge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 彻底删除回收站中的 ADB 设备（物理删除；被用例 default_device 引用时确认 detach；不可恢复） */
        post: operations["post_adb_device_purge_api_v1_adb_devices__device_id__purge_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notify-channels": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出通知渠道（config 逐键打码回显：token前5位•••• / url query 段[已配置]） */
        get: operations["get_notify_channel_list_api_v1_notify_channels_get"];
        put?: never;
        /** 创建通知渠道（WEBHOOK/DINGTALK/WECOM/FEISHU/EMAIL；敏感配置逐键 Fernet 加密落库，回显打码） */
        post: operations["post_notify_channel_create_api_v1_notify_channels_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notify-channels/{channel_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 获取单个通知渠道（config 打码回显 + last_send 最近一次发送结果） */
        get: operations["get_notify_channel_get_api_v1_notify_channels__channel_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 更新通知渠道（config 整体替换；值等于当前打码回显的键视为未改、保留旧密文） */
        patch: operations["patch_notify_channel_update_api_v1_notify_channels__channel_id__patch"];
        trace?: never;
    };
    "/api/v1/notify-channels/{channel_id}/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 删除通知渠道（被任何 schedule_task.notify_channel_ids 引用时 409 列出引用） */
        post: operations["post_notify_channel_delete_api_v1_notify_channels__channel_id__delete_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notify-channels/{channel_id}/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 测试发送：按渠道当前配置真发一条测试 Markdown，行内 ✓/✗ + 原始响应；结果回写 last_send（读类动作故 perm 以 :read 结尾——POST 不影响 glob 命中） */
        post: operations["post_notify_channel_test_api_v1_notify_channels__channel_id__test_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/schedule-tasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出项目内定时任务（显式按 project_id 过滤——表无 project_public 列，不许喂 visibility 助手；enabled 可选过滤） */
        get: operations["get_schedule_task_list_api_v1_schedule_tasks_get"];
        put?: never;
        /** 创建定时任务（cron 入库前 5 段校验，非法 422 带 crontab 原话；一期 subject_type 只支持 scenario——D30） */
        post: operations["post_schedule_task_create_api_v1_schedule_tasks_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/schedule-tasks/{task_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 获取单个定时任务（含 last_run 回执与连续失败计数） */
        get: operations["get_schedule_task_get_api_v1_schedule_tasks__task_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 更新定时任务（cron 改动同样过 5 段校验；enabled 开关即启停调度） */
        patch: operations["patch_schedule_task_update_api_v1_schedule_tasks__task_id__patch"];
        trace?: never;
    };
    "/api/v1/schedule-tasks/{task_id}/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 删除定时任务（调度真相在读表侧，删行即停排——无本地状态要清理） */
        post: operations["post_schedule_task_delete_api_v1_schedule_tasks__task_id__delete_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/schedule-tasks/next-5": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 预览未来 5 次触发时刻（§11.4.17 抽屉：保存前也能算——读草稿 cron 不落库；UTC 进 Shanghai 日历出，5 个时刻严格递增；cron 非法同样 422） */
        post: operations["post_schedule_task_next_5_api_v1_schedule_tasks_next_5_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/model-usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 按用户/按会话的模型用量统计（§6.8 一期）：聚合 agent 事件流里真实落库的 USAGE 回执（tokens）与轮次（run）；网关未回 usage 的会话 tokens 为 null（前端画「—」，不冒充已统计）；响应恒含 users+sessions+models 三组；一期模型全池共享，无项目作用域（project_id 仅过滤参数） */
        get: operations["get_model_usage_stats_api_v1_model_usage_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workbench-stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 工作台统计（§11.5.2）：资产数 / 近 7 天执行 / 通过率 / 失败 TOP1 场景 / 每日趋势 / 最近执行 10 条 / 我最近编辑 10 条（后者仅 scenario+ui_case，见 description 口径） */
        get: operations["get_workbench_stats_api_v1_workbench_stats_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/healthz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Healthz */
        get: operations["healthz_api_v1_healthz_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/readyz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Readyz */
        get: operations["readyz_api_v1_readyz_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** AdbCaseCreateIn */
        AdbCaseCreateIn: {
            /** Project Id */
            project_id: string;
            /** Name */
            name: string;
            /** Module Id */
            module_id?: string | null;
            /**
             * Priority
             * @default P2
             */
            priority: string;
            /**
             * Enabled
             * @default true
             */
            enabled: boolean;
            /** Steps */
            steps?: {
                [key: string]: unknown;
            }[] | null;
            /** Default Device */
            default_device?: string | null;
            /**
             * Project Public
             * @default true
             */
            project_public: boolean;
        };
        /** AdbCaseOut */
        AdbCaseOut: {
            /** Id */
            id: string;
            /** Project Id */
            project_id: string;
            /** Module Id */
            module_id?: string | null;
            /** Name */
            name: string;
            /**
             * Priority
             * @default P2
             */
            priority: string;
            /**
             * Enabled
             * @default true
             */
            enabled: boolean;
            /** Steps */
            steps?: {
                [key: string]: unknown;
            }[];
            /** Default Device */
            default_device?: string | null;
            /** Owner Id */
            owner_id?: string | null;
            /**
             * Project Public
             * @default true
             */
            project_public: boolean;
            /**
             * Status
             * @default normal
             */
            status: string;
            /**
             * Step Count
             * @default 0
             */
            step_count: number;
            /** Last Run At */
            last_run_at?: string | null;
            /** Last Run Status */
            last_run_status?: string | null;
            /** Updated By */
            updated_by?: string | null;
            /** Updated By Name */
            updated_by_name?: string | null;
            /** Created At */
            created_at?: string | null;
            /** Updated At */
            updated_at?: string | null;
            /** Issues */
            issues?: {
                [key: string]: unknown;
            }[];
        };
        /** AdbCaseReferencesOut */
        AdbCaseReferencesOut: {
            /** Items */
            items?: components["schemas"]["AdbScenarioRefItem"][];
            /**
             * Details Hidden
             * @default false
             */
            details_hidden: boolean;
        };
        /**
         * AdbDebugOut
         * @description 调试载荷：**不是** DebugOut（模块 docstring 有话）。R108 断言行在 commands[] 里。
         *
         *     mode/device 是 ADB 侧多出来的两键：降级不可见 = 纪律 1 违例（T6 交接），调试面板
         *     要当场说出「这案走的是 dump 轮询，慢但判定同一份」。
         */
        AdbDebugOut: {
            /** Run Id */
            run_id: string;
            /** Status */
            status: string;
            /** Ok */
            ok: boolean;
            /** Passed */
            passed: boolean;
            /**
             * Elapsed Ms
             * @default 0
             */
            elapsed_ms: number;
            /** Error */
            error?: string | null;
            /** Mode */
            mode?: string | null;
            /** Device */
            device?: string | null;
            /** Vars */
            vars?: {
                [key: string]: string;
            };
            /** Commands */
            commands?: {
                [key: string]: unknown;
            }[];
            /** Artifacts */
            artifacts?: {
                [key: string]: unknown;
            }[];
        };
        /** AdbDeviceCreateIn */
        AdbDeviceCreateIn: {
            /** Project Id */
            project_id: string;
            /** Name */
            name: string;
            /** Serial */
            serial: string;
            /**
             * Connect Type
             * @default wifi
             */
            connect_type: string;
            /** Wifi Addr */
            wifi_addr?: string | null;
            /**
             * Enabled
             * @default true
             */
            enabled: boolean;
            /**
             * Project Public
             * @default true
             */
            project_public: boolean;
        };
        /** AdbDeviceForceReleaseOut */
        AdbDeviceForceReleaseOut: {
            /**
             * Ok
             * @default true
             */
            ok: boolean;
            /** Device Id */
            device_id: string;
            /** Released Holder */
            released_holder: string | null;
        };
        /** AdbDeviceOccupationOut */
        AdbDeviceOccupationOut: {
            /** Device Id */
            device_id: string;
            /** Occupied */
            occupied: boolean;
            /** Holder */
            holder: string | null;
            /** Queued */
            queued: number;
        };
        /** AdbDeviceOut */
        AdbDeviceOut: {
            /** Id */
            id: string;
            /** Project Id */
            project_id: string;
            /** Name */
            name: string;
            /** Serial */
            serial: string;
            /**
             * Connect Type
             * @default wifi
             */
            connect_type: string;
            /** Wifi Addr */
            wifi_addr?: string | null;
            /**
             * Enabled
             * @default true
             */
            enabled: boolean;
            /** Last State */
            last_state?: {
                [key: string]: unknown;
            } | null;
            /** Owner Id */
            owner_id?: string | null;
            /**
             * Project Public
             * @default true
             */
            project_public: boolean;
            /**
             * Status
             * @default normal
             */
            status: string;
            /** Updated By */
            updated_by?: string | null;
            /** Updated By Name */
            updated_by_name?: string | null;
            /** Created At */
            created_at?: string | null;
            /** Updated At */
            updated_at?: string | null;
            /** Occupied By */
            occupied_by?: string | null;
            occupation?: components["schemas"]["AdbDeviceRowOccupation"] | null;
        };
        /**
         * AdbDeviceRowOccupation
         * @description 列表行上的占用读数（D47-b 步 5e）：字段口径与 AdbDeviceOccupationOut 的三件一致
         *     （occupied/holder/queued，单条端点继续用它，详情页与执行前判空还依赖那个形状）。
         *
         *     **行上的 null 与 occupied=false 是两回事**（§13 纪律 1：读不到 ≠ 空闲）：
         *     AdbDeviceOut.occupation=None 说「这次没读到」（Redis 故障，整页同缺），卡片不许据此画
         *     空闲；occupied=False + holder=None 说「读到了，真空闲」。前端拿 None 画「读数缺失」。
         */
        AdbDeviceRowOccupation: {
            /** Occupied */
            occupied: boolean;
            /** Holder */
            holder: string | null;
            /** Queued */
            queued: number;
        };
        /** AdbDeviceTestOut */
        AdbDeviceTestOut: {
            /** Ok */
            ok: boolean;
            /** Connected */
            connected: boolean;
            /** Message */
            message: string;
            /** Model */
            model?: string | null;
            /** Os Version */
            os_version?: string | null;
            /** Battery Level */
            battery_level?: number | null;
            /** Screenshot B64 */
            screenshot_b64?: string | null;
        };
        /** AdbModuleCreateIn */
        AdbModuleCreateIn: {
            /** Project Id */
            project_id: string;
            /** Parent Id */
            parent_id?: string | null;
            /** Name */
            name: string;
            /**
             * Sort
             * @default 0
             */
            sort: number;
        };
        /** AdbModuleNode */
        AdbModuleNode: {
            /** Id */
            id: string;
            /** Parent Id */
            parent_id?: string | null;
            /** Name */
            name: string;
            /**
             * Sort
             * @default 0
             */
            sort: number;
            /**
             * Status
             * @default normal
             */
            status: string;
            /**
             * Count
             * @default 0
             */
            count: number;
            /**
             * Children
             * @default []
             */
            children: components["schemas"]["AdbModuleNode"][];
        };
        /** AdbModulePurgeOut */
        AdbModulePurgeOut: {
            /**
             * Ok
             * @default true
             */
            ok: boolean;
            /**
             * Purged Modules
             * @default 0
             */
            purged_modules: number;
            /**
             * Detached Cases
             * @default 0
             */
            detached_cases: number;
        };
        /** AdbRunEnqueueOut */
        AdbRunEnqueueOut: {
            /** Run Id */
            run_id: string;
            /**
             * Status
             * @default queued
             */
            status: string;
        };
        /** AdbScenarioRefItem */
        AdbScenarioRefItem: {
            /** Scenario Id */
            scenario_id: string;
            /** Scenario Name */
            scenario_name: string;
            /** Step Keys */
            step_keys?: string[];
        };
        /**
         * ApiDebugIn
         * @description 调试入参：definition_id / request 二选一；variables 为调试临时最高优先级层。
         */
        ApiDebugIn: {
            /** Project Id */
            project_id: string;
            /** Definition Id */
            definition_id?: string | null;
            request?: components["schemas"]["RequestObject"] | null;
            /** Case Id */
            case_id?: string | null;
            /** Env Id */
            env_id?: string | null;
            /**
             * Variables
             * @default {}
             */
            variables: {
                [key: string]: string;
            };
            /** Subject Definition Id */
            subject_definition_id?: string | null;
        };
        /** ApiDefCreateIn */
        ApiDefCreateIn: {
            /** Project Id */
            project_id: string;
            /** Name */
            name: string;
            /** Method */
            method: string;
            /** Path */
            path: string;
            request?: components["schemas"]["RequestObject"] | null;
            /** Module Id */
            module_id?: string | null;
            /**
             * Project Public
             * @default true
             */
            project_public: boolean;
            /** Description */
            description?: string | null;
            /** Tags */
            tags?: string[];
        };
        /** ApiDefOut */
        ApiDefOut: {
            /** Id */
            id: string;
            /** Project Id */
            project_id: string;
            /** Module Id */
            module_id?: string | null;
            /** Name */
            name: string;
            /** Method */
            method: string;
            /** Path */
            path: string;
            /** Request */
            request?: {
                [key: string]: unknown;
            } | null;
            /**
             * Status
             * @default draft
             */
            status: string;
            /**
             * Version
             * @default 1
             */
            version: number;
            /** Owner Id */
            owner_id?: string | null;
            /** Owner Name */
            owner_name?: string | null;
            /** Description */
            description?: string | null;
            /** Tags */
            tags?: string[];
            /**
             * Project Public
             * @default true
             */
            project_public: boolean;
            /**
             * Produced
             * @default []
             */
            produced: components["schemas"]["ProducedRef"][];
            /** Updated At */
            updated_at?: string | null;
        };
        /**
         * ApiExportIn
         * @description 勾选（definition_ids）或全量（缺省 = 项目内全部非回收接口）。
         */
        ApiExportIn: {
            /** Project Id */
            project_id: string;
            /** Definition Ids */
            definition_ids?: string[] | null;
        };
        /**
         * ApiExportOut
         * @description openapi 是完整 OpenAPI3 文档（前端 blob 下载）；notes = 未导出/改写的人话如实报。
         */
        ApiExportOut: {
            /** Openapi */
            openapi: {
                [key: string]: unknown;
            };
            /**
             * Exported
             * @default 0
             */
            exported: number;
            /**
             * Notes
             * @default []
             */
            notes: string[];
        };
        /** Assertion */
        Assertion: {
            /** Type */
            type: string;
            /** Path */
            path?: string | null;
            /** Expected */
            expected?: unknown;
            /** Timeout Ms */
            timeout_ms?: number | null;
            /** Code */
            code?: string | null;
            /** Enabled */
            enabled?: boolean | null;
        };
        /** CaseCreateIn */
        CaseCreateIn: {
            /** Project Id */
            project_id: string;
            /** Definition Id */
            definition_id: string;
            /** Name */
            name: string;
            /**
             * Priority
             * @default P2
             */
            priority: string;
            request?: components["schemas"]["CaseOverlay"] | null;
            /**
             * Assertions
             * @default []
             */
            assertions: components["schemas"]["Assertion"][];
            /** Dataset Id */
            dataset_id?: string | null;
            /**
             * Sort
             * @default 0
             */
            sort: number;
            /**
             * Project Public
             * @default true
             */
            project_public: boolean;
        };
        /** CaseOut */
        CaseOut: {
            /** Id */
            id: string;
            /** Project Id */
            project_id: string;
            /** Definition Id */
            definition_id: string;
            /** Name */
            name: string;
            /** Priority */
            priority: string;
            /** Request */
            request?: {
                [key: string]: unknown;
            } | null;
            /**
             * Assertions
             * @default []
             */
            assertions: {
                [key: string]: unknown;
            }[];
            /** Dataset Id */
            dataset_id?: string | null;
            /**
             * Sort
             * @default 0
             */
            sort: number;
            /** Owner Id */
            owner_id?: string | null;
            /**
             * Project Public
             * @default true
             */
            project_public: boolean;
            /**
             * Status
             * @default normal
             */
            status: string;
            /** Effective Request */
            effective_request?: {
                [key: string]: unknown;
            } | null;
            /**
             * Produced
             * @default []
             */
            produced: components["schemas"]["ProducedRef"][];
        };
        /**
         * CaseOverlay
         * @description 用例对定义的按键覆盖层：缺省键 = 继承定义。
         */
        CaseOverlay: {
            /** Method */
            method?: ("GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS") | null;
            /** Url */
            url?: string | null;
            /** Params */
            params?: string[][] | null;
            /** Headers */
            headers?: string[][] | null;
            auth?: components["schemas"]["RequestAuth"] | null;
            body?: components["schemas"]["RequestBody"] | null;
            /** Timeout Ms */
            timeout_ms?: number | null;
        };
        /** CfgCreateIn */
        CfgCreateIn: {
            /** Name */
            name: string;
            /**
             * Model Type
             * @default CHAT
             * @enum {string}
             */
            model_type: "CHAT" | "EMBEDDING";
            /**
             * Protocol
             * @default OPENAI_COMPAT
             * @enum {string}
             */
            protocol: "OPENAI_COMPAT" | "ANTHROPIC";
            /** Base Url */
            base_url: string;
            /** Model Name */
            model_name: string;
            /**
             * Api Key
             * @default
             */
            api_key: string;
            /**
             * Context Window
             * @default 32768
             */
            context_window: number;
            /**
             * Max Output
             * @default 4096
             */
            max_output: number;
            /**
             * Supports Thinking
             * @default false
             */
            supports_thinking: boolean;
            /** Thinking Levels */
            thinking_levels?: string[] | null;
            /**
             * Supports Vision
             * @default false
             */
            supports_vision: boolean;
            /**
             * Supports Tools
             * @default true
             */
            supports_tools: boolean;
            /** Temperature Default */
            temperature_default?: number | null;
            /**
             * Enabled
             * @default true
             */
            enabled: boolean;
            /**
             * Is Default
             * @default false
             */
            is_default: boolean;
        };
        /** CfgOut */
        CfgOut: {
            /** Id */
            id: string;
            /** Name */
            name: string;
            /** Model Type */
            model_type: string;
            /** Protocol */
            protocol: string;
            /** Base Url */
            base_url: string;
            /** Model Name */
            model_name: string;
            /** Api Key Masked */
            api_key_masked: string;
            /** Context Window */
            context_window: number;
            /** Max Output */
            max_output: number;
            /** Supports Thinking */
            supports_thinking: boolean;
            /** Thinking Levels */
            thinking_levels?: string[] | null;
            /** Supports Vision */
            supports_vision: boolean;
            /** Supports Tools */
            supports_tools: boolean;
            /** Temperature Default */
            temperature_default?: number | null;
            /** Enabled */
            enabled: boolean;
            /** Is Default */
            is_default: boolean;
            /** Embed Dimensions */
            embed_dimensions?: number | null;
            /** Thinking Default */
            thinking_default?: string | null;
            /** Probe Result */
            probe_result?: {
                [key: string]: unknown;
            } | null;
        };
        /** ChannelCreateIn */
        ChannelCreateIn: {
            /** Name */
            name: string;
            /** Type */
            type: string;
            /** Config */
            config?: {
                [key: string]: unknown;
            };
        };
        /** ChannelOut */
        ChannelOut: {
            /** Id */
            id: string;
            /** Name */
            name: string;
            /** Type */
            type: string;
            /** Config */
            config: {
                [key: string]: unknown;
            };
            /** Last Send */
            last_send?: {
                [key: string]: unknown;
            } | null;
            /** Created At */
            created_at?: string | null;
            /** Updated At */
            updated_at?: string | null;
        };
        /** ChannelTestOut */
        ChannelTestOut: {
            /** Ok */
            ok: boolean;
            /**
             * Latency Ms
             * @default 0
             */
            latency_ms: number;
            /** Error */
            error?: string | null;
            /** Raw */
            raw?: string | null;
            /** Last Send */
            last_send?: {
                [key: string]: unknown;
            } | null;
        };
        /** CustomRoleOut */
        CustomRoleOut: {
            /** Code */
            code: string;
            /** Project Id */
            project_id: string;
            /** Name */
            name: string;
            /**
             * Perms
             * @default []
             */
            perms: string[];
            /** Template Code */
            template_code: string;
        };
        /** DatasetCreateIn */
        DatasetCreateIn: {
            /** Project Id */
            project_id: string;
            /** Name */
            name: string;
            /** Columns */
            columns: string[];
            /** Rows */
            rows: string[][];
        };
        /** DatasetOut */
        DatasetOut: {
            /** Id */
            id: string;
            /** Project Id */
            project_id: string;
            /** Name */
            name: string;
            /** Columns */
            columns: string[];
            /** Rows */
            rows: string[][];
            /**
             * Row Count
             * @default 0
             */
            row_count: number;
            /**
             * Used By
             * @default 0
             */
            used_by: number;
            /**
             * Scenario Held
             * @default false
             */
            scenario_held: boolean;
            /**
             * Produced
             * @default []
             */
            produced: components["schemas"]["ProducedRef"][];
        };
        /** DebugOut */
        DebugOut: {
            /** Run Id */
            run_id: string;
            /** Ok */
            ok: boolean;
            /** Passed */
            passed: boolean;
            /** Status */
            status?: number | null;
            /**
             * Headers
             * @default {}
             */
            headers: {
                [key: string]: string;
            };
            /** Body Text */
            body_text?: string | null;
            /**
             * Truncated
             * @default false
             */
            truncated: boolean;
            /**
             * Body Size
             * @default 0
             */
            body_size: number;
            /**
             * Elapsed Ms
             * @default 0
             */
            elapsed_ms: number;
            /** Error */
            error?: string | null;
            /**
             * Assertions
             * @default []
             */
            assertions: {
                [key: string]: unknown;
            }[];
            /** Env Name */
            env_name?: string | null;
        };
        /** EnvCreateIn */
        EnvCreateIn: {
            /** Project Id */
            project_id: string;
            /** Name */
            name: string;
            /**
             * Position
             * @default 0
             */
            position: number;
            /** Config */
            config?: {
                [key: string]: unknown;
            } | null;
        };
        /** EnvOut */
        EnvOut: {
            /** Id */
            id: string;
            /** Project Id */
            project_id: string;
            /** Name */
            name: string;
            /**
             * Position
             * @default 0
             */
            position: number;
            /** Config */
            config?: {
                [key: string]: unknown;
            } | null;
        };
        /**
         * FilterMetaOut
         * @description 高级搜索能力清单：操作符全集 + 每种字段类型可用的子集 + 指定页面的可筛字段。
         *
         *     前端表单**照这个渲染**，不在前端另抄一份字段名或操作符清单——第 29 轮那条轴（同一枚举
         *     多端镜像）的教训是手抄必然漂。前端那份镜像表由测试逐字读本模块核对（`shared/assertions.py`
         *     同法），而字段清单连镜像都不需要：直接来自 `filter_meta` 的响应。
         */
        FilterMetaOut: {
            /** Operators */
            operators: string[];
            /** Labels */
            labels: {
                [key: string]: string;
            };
            /** Kinds */
            kinds: {
                [key: string]: string[];
            };
            /** Unavailable */
            unavailable?: {
                [key: string]: string;
            };
            /** Supported View Types */
            supported_view_types?: string[];
            /** Fields */
            fields?: {
                [key: string]: unknown;
            }[];
            /** View Label */
            view_label?: string | null;
        };
        /** GlobalConfigUpdateIn */
        GlobalConfigUpdateIn: {
            /** Project Id */
            project_id: string;
            /** Scope Type */
            scope_type: string;
            /**
             * Items
             * @default []
             */
            items: string[][];
        };
        /** HTTPValidationError */
        HTTPValidationError: {
            /** Detail */
            detail?: components["schemas"]["ValidationError"][];
        };
        /**
         * ImportCommitIn
         * @description 步骤③的载荷：整批一事务——失败条目只记账，不污染事务；崩了整体不 commit。
         */
        ImportCommitIn: {
            /** Project Id */
            project_id: string;
            /** Items */
            items: components["schemas"]["ImportCommitItem"][];
        };
        /** ImportCommitItem */
        ImportCommitItem: {
            /** Name */
            name: string;
            /** Method */
            method: string;
            /** Path */
            path: string;
            /** Request */
            request: {
                [key: string]: unknown;
            };
            /**
             * Strategy
             * @default overwrite
             */
            strategy: string;
            /** Definition Id */
            definition_id?: string | null;
        };
        /**
         * ImportPreviewIn
         * @description 步骤①：三选一的源 + 文本/URL 二选一（URL 由后端代拉：trust_env=False/5s/2MB）。
         */
        ImportPreviewIn: {
            /** Project Id */
            project_id: string;
            /** Source */
            source: string;
            /** Text */
            text?: string | null;
            /** Url */
            url?: string | null;
        };
        /** InterruptIn */
        InterruptIn: {
            /** Run Id */
            run_id: string;
        };
        /** LoginIn */
        LoginIn: {
            /** Account */
            account: string;
            /** Password */
            password: string;
        };
        /** LoginOut */
        LoginOut: {
            /** Token */
            token: string;
            user: components["schemas"]["UserOut"];
        };
        /** MemberIn */
        MemberIn: {
            /** Role Code */
            role_code: string;
        };
        /** MessageIn */
        MessageIn: {
            /** Content */
            content: string;
        };
        /** ModelUsageOut */
        ModelUsageOut: {
            /** Scope */
            scope?: {
                [key: string]: unknown;
            };
            /** Filters */
            filters?: {
                [key: string]: unknown;
            };
            /** Totals */
            totals?: {
                [key: string]: unknown;
            };
            /** Users */
            users?: components["schemas"]["UserUsageRow"][];
            /** Sessions */
            sessions?: components["schemas"]["SessionUsageRow"][];
            /** Models */
            models?: components["schemas"]["ModelUsageRow"][];
        };
        /**
         * ModelUsageRow
         * @description 按模型一行——§11.4.23 模型卡「用量 N 会话」的数据源（只有真实 usage 回执计数，
         *     一张回执都没有的模型 usage_sessions=0 → 前端「—」）。
         */
        ModelUsageRow: {
            /** Model Id */
            model_id: string;
            /** Model Name */
            model_name: string;
            /**
             * Sessions
             * @default 0
             */
            sessions: number;
            /**
             * Usage Sessions
             * @default 0
             */
            usage_sessions: number;
            /**
             * Turns
             * @default 0
             */
            turns: number;
            /** Input Tokens */
            input_tokens?: number | null;
            /** Output Tokens */
            output_tokens?: number | null;
            /** Total Tokens */
            total_tokens?: number | null;
        };
        /** ModuleCreateIn */
        ModuleCreateIn: {
            /** Project Id */
            project_id: string;
            /** Parent Id */
            parent_id?: string | null;
            /** Name */
            name: string;
            /**
             * Sort
             * @default 0
             */
            sort: number;
        };
        /** ModuleNode */
        ModuleNode: {
            /** Id */
            id: string;
            /** Parent Id */
            parent_id?: string | null;
            /** Name */
            name: string;
            /**
             * Sort
             * @default 0
             */
            sort: number;
            /**
             * Status
             * @default normal
             */
            status: string;
            /**
             * Count
             * @default 0
             */
            count: number;
            /**
             * Children
             * @default []
             */
            children: components["schemas"]["ModuleNode"][];
        };
        /** Next5In */
        Next5In: {
            /** Project Id */
            project_id: string;
            /** Cron */
            cron: string;
            /** Base */
            base?: string | null;
        };
        /** Next5Out */
        Next5Out: {
            /** Cron */
            cron: string;
            /** Times */
            times: string[];
        };
        /**
         * OkOut
         * @description 通用无害返回（删除/ack）：响应模型必须是具体类，不能是裸 BaseModel。
         */
        OkOut: {
            /**
             * Ok
             * @default true
             */
            ok: boolean;
        };
        /** PasswordChangeIn */
        PasswordChangeIn: {
            /** Old Password */
            old_password: string;
            /** New Password */
            new_password: string;
        };
        /** PermTreeNode */
        PermTreeNode: {
            /** Key */
            key: string;
            /** Title */
            title: string;
            /**
             * Children
             * @default []
             */
            children: components["schemas"]["PermTreeNode"][];
        };
        /** PlanCreateIn */
        PlanCreateIn: {
            /** Project Id */
            project_id: string;
            /** Name */
            name: string;
            /** Description */
            description?: string | null;
        };
        /** PlanLinkOut */
        PlanLinkOut: {
            /** Id */
            id: string;
            /** Project Id */
            project_id: string;
            /** Plan Id */
            plan_id: string;
            /** Subject Type */
            subject_type: string;
            /** Subject Id */
            subject_id: string;
            /** Subject Name */
            subject_name: string;
            /** Env Id */
            env_id?: string | null;
            /** Created By */
            created_by?: string | null;
            /** Created At */
            created_at?: string | null;
            /** Updated At */
            updated_at?: string | null;
        };
        /**
         * PlanLinkStatusOut
         * @description 一条关联的现算结论。三问全是**与顺序无关**的「有没有过…」（services._link_result）：
         *
         *     - executed：该关联存在至少一条**终态**（passed/failed/error）run（§六 3 的「已执行」定义）；
         *     - executing：存在 queued/running 的 run——界面据此显示「执行中」而不是「没跑过」；
         *       它与 executed 可以同时为真（跑完过、此刻又在跑），两个布尔各答各的，不互相吞；
         *     - result：有终态时取 passed/failed（终态里出现过 failed/error 即 failed，保守口径，
         *       见 services 的步 3 判断 2），没终态恒 none。**queued/running 不进这个枚举**——
         *       把非 passed 当失败 = 照 execution/models.py:26 那句错注释写代码（步 3 判断 1）。
         */
        PlanLinkStatusOut: {
            /** Link Id */
            link_id: string;
            /** Subject Type */
            subject_type: string;
            /** Subject Id */
            subject_id: string;
            /** Subject Name */
            subject_name: string;
            /** Env Id */
            env_id?: string | null;
            /** Executed */
            executed: boolean;
            /** Executing */
            executing: boolean;
            /** Result */
            result: string;
        };
        /** PlanOut */
        PlanOut: {
            /** Id */
            id: string;
            /** Project Id */
            project_id: string;
            /** Name */
            name: string;
            /** Description */
            description?: string | null;
            /** Archived */
            archived: boolean;
            /** Created By */
            created_by?: string | null;
            /** Updated By */
            updated_by?: string | null;
            /** Created At */
            created_at?: string | null;
            /** Updated At */
            updated_at?: string | null;
        };
        /**
         * PlanReportItemOut
         * @description 报告明细行 = 生成时刻的副本。每个键都是抄下来的值，读取路径零重算、零 join。
         */
        PlanReportItemOut: {
            /** Id */
            id: string;
            /** Report Id */
            report_id: string;
            /** Link Id */
            link_id: string;
            /** Subject Type */
            subject_type: string;
            /** Subject Id */
            subject_id: string;
            /** Subject Name */
            subject_name: string;
            /** Env Id */
            env_id?: string | null;
            /** Executed */
            executed: boolean;
            /** Executing */
            executing: boolean;
            /** Result */
            result: string;
            /** Created At */
            created_at?: string | null;
            /** Updated At */
            updated_at?: string | null;
        };
        /**
         * PlanReportOut
         * @description 报告头 + 明细。数字 = 生成时刻的一份副本（§二 2）：
         *
         *     pass_rate / execute_rate / not_executed 是**读时从存量计数派生**的纯函数
         *     （口径逐字 = 步 3 的 PlanStatusOut：分母 = total、空计划 0.0 不是 1.0），
         *     不是独立存列——存两份会各自漂移的数 = §三 2 那类病。status 是生成时刻
         *     _plan_display 的快照**列**：之后归档/新 run 都不动它，读取路径不许现算
         *     （「读取路径改成现算」正是本刀变异自证点名要杀的形状）。
         */
        PlanReportOut: {
            /** Id */
            id: string;
            /** Project Id */
            project_id: string;
            /** Plan Id */
            plan_id: string;
            /** Name */
            name: string;
            /** Status */
            status: string;
            /** Total */
            total: number;
            /** Passed */
            passed: number;
            /** Failed */
            failed: number;
            /** Executed */
            executed: number;
            /** Executing */
            executing: number;
            /** Not Executed */
            not_executed: number;
            /** Pass Rate */
            pass_rate: number;
            /** Execute Rate */
            execute_rate: number;
            /** Created By */
            created_by?: string | null;
            /** Created At */
            created_at?: string | null;
            /** Updated At */
            updated_at?: string | null;
            /** Items */
            items: components["schemas"]["PlanReportItemOut"][];
        };
        /**
         * PlanStatusOut
         * @description 计划实时状态：**每次查询现算，库里一个展示态列都没有**（§二 1）。
         *
         *     分母口径（§六 3，业主裁死）：pass_rate = passed ÷ **total**；execute_rate =
         *     executed ÷ **total**。**未执行（含执行中）拉低通过率**——「跑一半」不算跑完，
         *     执行率不许在还有一堆用例在机器上跑着的时候先走到 1.0。空计划两个率都是 0.0，
         *     不是 1.0：「空集合全部已执行」在逻辑上是空真，在界面上是说谎。
         */
        PlanStatusOut: {
            /** Plan Id */
            plan_id: string;
            /** Project Id */
            project_id: string;
            /** Name */
            name: string;
            /** Archived */
            archived: boolean;
            /** Status */
            status: string;
            /** Total */
            total: number;
            /** Passed */
            passed: number;
            /** Failed */
            failed: number;
            /** Executed */
            executed: number;
            /** Executing */
            executing: number;
            /** Not Executed */
            not_executed: number;
            /** Pass Rate */
            pass_rate: number;
            /** Execute Rate */
            execute_rate: number;
            /** Links */
            links: components["schemas"]["PlanLinkStatusOut"][];
        };
        /** ProbeOut */
        ProbeOut: {
            /** Ok */
            ok: boolean;
            /**
             * Latency Ms
             * @default 0
             */
            latency_ms: number;
            /**
             * Capabilities
             * @default {}
             */
            capabilities: {
                [key: string]: unknown;
            };
            /** Error */
            error?: string | null;
            /** Embed Dimensions */
            embed_dimensions?: number | null;
            /** Probe Result */
            probe_result?: {
                [key: string]: unknown;
            } | null;
        };
        /** ProducedRef */
        ProducedRef: {
            /** Kind */
            kind: string;
            /** Id */
            id: string;
            /** Name */
            name: string;
            /** Link */
            link: string;
        };
        /** ProjectIn */
        ProjectIn: {
            /** Name */
            name: string;
            /** Description */
            description?: string | null;
        };
        /** ProjectOut */
        ProjectOut: {
            /** Id */
            id: string;
            /** Name */
            name: string;
            /** Description */
            description?: string | null;
            /**
             * Status
             * @default normal
             */
            status: string;
            /** My Role */
            my_role?: string | null;
            /**
             * My Perms
             * @default []
             */
            my_perms: string[];
        };
        /** ProjectUpdateIn */
        ProjectUpdateIn: {
            /** Name */
            name?: string | null;
            /** Description */
            description?: string | null;
        };
        /**
         * RefreshOut
         * @description /auth/refresh 响应：只回新 access；新 refresh 走 Set-Cookie，不进 JSON body
         *     （body 里出现 refresh 等于把它递给任何能读响应的脚本，Cookie 的 HttpOnly 就白设了）。
         */
        RefreshOut: {
            /** Token */
            token: string;
        };
        /**
         * RequestAuth
         * @description §7.1 auth 子集（1A 只实现 basic/bearer）。
         *
         *     type 在写入层就收紧：apikey 等未实现值存不进来（422 里看得见可选值），
         *     比「存得下、跑起来才炸」诚实；执行层 request_auth.py 仍对每个收到的值
         *     点名拒绝——它同时服务无 schema 的自由 JSON 通道（场景 http_direct）。
         *     type 必填（无缺省）：{"config": {...}} 漏 type 若默认 none 会静默吞掉 config。
         */
        RequestAuth: {
            /**
             * Type
             * @enum {string}
             */
            type: "none" | "basic" | "bearer";
            /**
             * Config
             * @default {}
             */
            config: {
                [key: string]: unknown;
            };
        };
        /** RequestBody */
        RequestBody: {
            /**
             * Type
             * @default none
             * @enum {string}
             */
            type: "none" | "json" | "text" | "form";
            /** Content */
            content?: string | null;
        };
        /**
         * RequestObject
         * @description §7.1 请求对象（S0：执行在 1A，存储与校验在 S0）。
         */
        RequestObject: {
            /**
             * Method
             * @enum {string}
             */
            method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";
            /** Url */
            url: string;
            /**
             * Params
             * @default []
             */
            params: string[][];
            /**
             * Headers
             * @default []
             */
            headers: string[][];
            auth?: components["schemas"]["RequestAuth"] | null;
            /**
             * @default {
             *       "type": "none"
             *     }
             */
            body: components["schemas"]["RequestBody"];
            /**
             * Timeout Ms
             * @default 10000
             */
            timeout_ms: number;
            /**
             * Assertions
             * @default []
             */
            assertions: components["schemas"]["Assertion"][];
        };
        /** RerunStepOut */
        RerunStepOut: {
            /** Run Id */
            run_id: string;
            /** Status */
            status: string;
            /** Rerun Of */
            rerun_of: string;
        };
        /** RoleCreateIn */
        RoleCreateIn: {
            /** Project Id */
            project_id: string;
            /** Name */
            name: string;
            /** Template Code */
            template_code: string;
            /** Perms */
            perms?: string[] | null;
            /** Code */
            code?: string | null;
        };
        /** RolePermTreeOut */
        RolePermTreeOut: {
            /**
             * Nodes
             * @default []
             */
            nodes: components["schemas"]["PermTreeNode"][];
            /**
             * Templates
             * @default []
             */
            templates: components["schemas"]["RoleTemplateOut"][];
        };
        /** RoleTemplateOut */
        RoleTemplateOut: {
            /** Code */
            code: string;
            /** Name */
            name: string;
            /**
             * Perms
             * @default []
             */
            perms: string[];
        };
        /** RunCancelOut */
        RunCancelOut: {
            /**
             * Ok
             * @default true
             */
            ok: boolean;
            /** Status */
            status: string;
        };
        /** RunEnqueueOut */
        RunEnqueueOut: {
            /** Run Id */
            run_id: string;
            /**
             * Status
             * @default queued
             */
            status: string;
        };
        /** ScenarioBatchMoveIn */
        ScenarioBatchMoveIn: {
            /** Project Id */
            project_id: string;
            /** Scenario Ids */
            scenario_ids: string[];
            /** Module Id */
            module_id?: string | null;
        };
        /** ScenarioCreateIn */
        ScenarioCreateIn: {
            /** Project Id */
            project_id: string;
            /** Name */
            name: string;
            /** Module Id */
            module_id?: string | null;
            /**
             * Priority
             * @default P2
             */
            priority: string;
            /** Tags */
            tags?: string[];
            /** Step Graph */
            step_graph?: {
                [key: string]: unknown;
            };
            /**
             * Variables
             * @default {}
             */
            variables: {
                [key: string]: string;
            };
            /**
             * Fail Fast
             * @default true
             */
            fail_fast: boolean;
            /** Max Runtime Ms */
            max_runtime_ms?: number | null;
            /** Common Assertions */
            common_assertions?: {
                [key: string]: unknown;
            }[];
            /** Env Id */
            env_id?: string | null;
            /**
             * Project Public
             * @default true
             */
            project_public: boolean;
        };
        /**
         * ScenarioExportIn
         * @description 勾选（scenario_ids）或全量（缺省 = 项目内全部非回收可见场景；口径同接口域 ApiExportIn）。
         */
        ScenarioExportIn: {
            /** Project Id */
            project_id: string;
            /** Scenario Ids */
            scenario_ids?: string[] | null;
        };
        /**
         * ScenarioExportOut
         * @description scenarios = 每条场景一份**只读备份快照**（step_graph 逐字 + 保存期同口径 validate 判定
         *     + 引用原样 ref）；notes = 未导出/限制的人话如实报。
         *
         *     **只读导出，不可回灌**（与接口域 api_export 的刻意分歧，见 export_services 模块 docstring）：
         *     导入侧没有场景解析器，声称可回灌就是自证无门；validate 判定让导出内容至少能被判真假。
         */
        ScenarioExportOut: {
            /**
             * Scenarios
             * @default []
             */
            scenarios: {
                [key: string]: unknown;
            }[];
            /**
             * Exported
             * @default 0
             */
            exported: number;
            /**
             * Notes
             * @default []
             */
            notes: string[];
        };
        /** ScenarioModuleCreateIn */
        ScenarioModuleCreateIn: {
            /** Project Id */
            project_id: string;
            /** Parent Id */
            parent_id?: string | null;
            /** Name */
            name: string;
            /**
             * Sort
             * @default 0
             */
            sort: number;
        };
        /** ScenarioModuleNode */
        ScenarioModuleNode: {
            /** Id */
            id: string;
            /** Parent Id */
            parent_id?: string | null;
            /** Name */
            name: string;
            /**
             * Sort
             * @default 0
             */
            sort: number;
            /**
             * Status
             * @default normal
             */
            status: string;
            /**
             * Count
             * @default 0
             */
            count: number;
            /**
             * Children
             * @default []
             */
            children: components["schemas"]["ScenarioModuleNode"][];
        };
        /** ScenarioOut */
        ScenarioOut: {
            /** Id */
            id: string;
            /** Project Id */
            project_id: string;
            /** Module Id */
            module_id?: string | null;
            /** Name */
            name: string;
            /**
             * Status
             * @default normal
             */
            status: string;
            /**
             * Priority
             * @default P2
             */
            priority: string;
            /** Tags */
            tags?: string[];
            /** Step Graph */
            step_graph?: {
                [key: string]: unknown;
            };
            /**
             * Variables
             * @default {}
             */
            variables: {
                [key: string]: string;
            };
            /**
             * Fail Fast
             * @default true
             */
            fail_fast: boolean;
            /** Max Runtime Ms */
            max_runtime_ms?: number | null;
            /** Common Assertions */
            common_assertions?: {
                [key: string]: unknown;
            }[];
            /** Env Id */
            env_id?: string | null;
            /** Owner Id */
            owner_id?: string | null;
            /**
             * Project Public
             * @default true
             */
            project_public: boolean;
            /**
             * Version
             * @default 1
             */
            version: number;
            /**
             * Step Count
             * @default 0
             */
            step_count: number;
            /** Last Run At */
            last_run_at?: string | null;
            /** Last Run Status */
            last_run_status?: string | null;
            /** Updated By */
            updated_by?: string | null;
            /** Updated By Name */
            updated_by_name?: string | null;
            /** Created At */
            created_at?: string | null;
            /** Updated At */
            updated_at?: string | null;
            /**
             * Issues
             * @default []
             */
            issues: {
                [key: string]: unknown;
            }[];
            /**
             * Produced
             * @default []
             */
            produced: {
                [key: string]: string;
            }[];
        };
        /** ScenarioRefItem */
        ScenarioRefItem: {
            /** Scenario Id */
            scenario_id: string;
            /** Scenario Name */
            scenario_name: string;
            /** Step Keys */
            step_keys?: string[];
        };
        /** ScenarioReferenceItem */
        ScenarioReferenceItem: {
            /** Scenario Id */
            scenario_id: string;
            /** Scenario Name */
            scenario_name: string;
            /** Step Keys */
            step_keys: string[];
        };
        /** ScenarioReferencesOut */
        ScenarioReferencesOut: {
            /**
             * Items
             * @default []
             */
            items: components["schemas"]["ScenarioReferenceItem"][];
        };
        /** SearchAssetItem */
        SearchAssetItem: {
            /** Id */
            id: string;
            /** Name */
            name: string;
            /** Method */
            method?: string | null;
            /** Path */
            path?: string | null;
            /** Definition Id */
            definition_id?: string | null;
            /** Definition Name */
            definition_name?: string | null;
            /** Priority */
            priority?: string | null;
        };
        /** SearchAssetsOut */
        SearchAssetsOut: {
            /**
             * Definitions
             * @default []
             */
            definitions: components["schemas"]["SearchAssetItem"][];
            /**
             * Cases
             * @default []
             */
            cases: components["schemas"]["SearchAssetItem"][];
            /**
             * Scenarios
             * @default []
             */
            scenarios: components["schemas"]["SearchAssetItem"][];
            /**
             * Ui Elements
             * @default []
             */
            ui_elements: components["schemas"]["SearchAssetItem"][];
            /**
             * Ui Cases
             * @default []
             */
            ui_cases: components["schemas"]["SearchAssetItem"][];
            /**
             * Adb Cases
             * @default []
             */
            adb_cases: components["schemas"]["SearchAssetItem"][];
            /**
             * Schedules
             * @default []
             */
            schedules: components["schemas"]["SearchAssetItem"][];
            /**
             * Notify Channels
             * @default []
             */
            notify_channels: components["schemas"]["SearchAssetItem"][];
        };
        /** SessionIn */
        SessionIn: {
            /** Project Id */
            project_id: string;
            /** Model Id */
            model_id?: string | null;
            /**
             * Thinking
             * @default medium
             * @enum {string}
             */
            thinking: "off" | "low" | "medium" | "high";
            /**
             * Mode
             * @default ASK
             * @enum {string}
             */
            mode: "PLAN" | "ASK" | "FULL";
        };
        /** SessionUsageRow */
        SessionUsageRow: {
            /** Session Id */
            session_id: string;
            /** Title */
            title: string;
            /** User Id */
            user_id: string;
            /** User Name */
            user_name: string;
            /** Project Id */
            project_id: string;
            /** Model Id */
            model_id?: string | null;
            /** Model Name */
            model_name?: string | null;
            /**
             * Turns
             * @default 0
             */
            turns: number;
            /** Input Tokens */
            input_tokens?: number | null;
            /** Output Tokens */
            output_tokens?: number | null;
            /** Total Tokens */
            total_tokens?: number | null;
        };
        /** TaskCreateIn */
        TaskCreateIn: {
            /** Project Id */
            project_id: string;
            /** Name */
            name: string;
            /** Subject Type */
            subject_type: string;
            /** Subject Id */
            subject_id: string;
            /** Cron */
            cron: string;
            /** Env Id */
            env_id?: string | null;
            /**
             * Enabled
             * @default 1
             */
            enabled: number;
            /** Notify Channel Ids */
            notify_channel_ids?: string[];
        };
        /** TaskOut */
        TaskOut: {
            /** Id */
            id: string;
            /** Project Id */
            project_id: string;
            /** Name */
            name: string;
            /** Subject Type */
            subject_type: string;
            /** Subject Id */
            subject_id: string;
            /** Cron */
            cron: string;
            /** Env Id */
            env_id?: string | null;
            /** Enabled */
            enabled: number;
            /** Notify Channel Ids */
            notify_channel_ids?: string[];
            /** Last Run */
            last_run?: {
                [key: string]: unknown;
            } | null;
            /**
             * Consecutive Failures
             * @default 0
             */
            consecutive_failures: number;
            /** Created At */
            created_at?: string | null;
            /** Updated At */
            updated_at?: string | null;
        };
        /** UiCaseCreateIn */
        UiCaseCreateIn: {
            /** Project Id */
            project_id: string;
            /** Name */
            name: string;
            /** Module Id */
            module_id?: string | null;
            /**
             * Priority
             * @default P2
             */
            priority: string;
            /**
             * Enabled
             * @default true
             */
            enabled: boolean;
            /** Steps */
            steps?: {
                [key: string]: unknown;
            }[] | null;
            /** Env Id */
            env_id?: string | null;
            /**
             * Project Public
             * @default true
             */
            project_public: boolean;
        };
        /** UiCaseOut */
        UiCaseOut: {
            /** Id */
            id: string;
            /** Project Id */
            project_id: string;
            /** Module Id */
            module_id?: string | null;
            /** Name */
            name: string;
            /**
             * Priority
             * @default P2
             */
            priority: string;
            /**
             * Enabled
             * @default true
             */
            enabled: boolean;
            /** Steps */
            steps?: {
                [key: string]: unknown;
            }[];
            /** Env Id */
            env_id?: string | null;
            /** Owner Id */
            owner_id?: string | null;
            /**
             * Project Public
             * @default true
             */
            project_public: boolean;
            /**
             * Status
             * @default normal
             */
            status: string;
            /**
             * Step Count
             * @default 0
             */
            step_count: number;
            /** Last Run At */
            last_run_at?: string | null;
            /** Last Run Status */
            last_run_status?: string | null;
            /** Updated By */
            updated_by?: string | null;
            /** Updated By Name */
            updated_by_name?: string | null;
            /** Created At */
            created_at?: string | null;
            /** Updated At */
            updated_at?: string | null;
            /** Issues */
            issues?: {
                [key: string]: unknown;
            }[];
        };
        /** UiCaseReferencesOut */
        UiCaseReferencesOut: {
            /** Items */
            items?: components["schemas"]["ScenarioRefItem"][];
            /**
             * Details Hidden
             * @default false
             */
            details_hidden: boolean;
        };
        /**
         * UiDebugOut
         * @description 调试载荷：**不是** DebugOut（模块 docstring 有话）。R108 断言行在 commands[] 里。
         */
        UiDebugOut: {
            /** Run Id */
            run_id: string;
            /** Status */
            status: string;
            /** Ok */
            ok: boolean;
            /** Passed */
            passed: boolean;
            /**
             * Elapsed Ms
             * @default 0
             */
            elapsed_ms: number;
            /** Error */
            error?: string | null;
            /** Env Name */
            env_name?: string | null;
            /** Vars */
            vars?: {
                [key: string]: string;
            };
            /** Commands */
            commands?: {
                [key: string]: unknown;
            }[];
            /** Artifacts */
            artifacts?: {
                [key: string]: unknown;
            }[];
        };
        /** UiElementCreateIn */
        UiElementCreateIn: {
            /** Project Id */
            project_id: string;
            /** Name */
            name: string;
            /** Locator Type */
            locator_type: string;
            /** Locator */
            locator: string;
            /** Module Id */
            module_id?: string | null;
            /** Comment */
            comment?: string | null;
            /**
             * Project Public
             * @default true
             */
            project_public: boolean;
        };
        /** UiElementOut */
        UiElementOut: {
            /** Id */
            id: string;
            /** Project Id */
            project_id: string;
            /** Module Id */
            module_id?: string | null;
            /** Name */
            name: string;
            /** Locator Type */
            locator_type: string;
            /** Locator */
            locator: string;
            /** Comment */
            comment?: string | null;
            /** Owner Id */
            owner_id?: string | null;
            /**
             * Project Public
             * @default true
             */
            project_public: boolean;
            /**
             * Status
             * @default normal
             */
            status: string;
            /** Updated By */
            updated_by?: string | null;
            /** Updated By Name */
            updated_by_name?: string | null;
            /** Created At */
            created_at?: string | null;
            /** Updated At */
            updated_at?: string | null;
            /**
             * Used By
             * @default 0
             */
            used_by: number;
        };
        /** UiModuleCreateIn */
        UiModuleCreateIn: {
            /** Project Id */
            project_id: string;
            /** Parent Id */
            parent_id?: string | null;
            /** Name */
            name: string;
            /**
             * Sort
             * @default 0
             */
            sort: number;
        };
        /** UiModuleNode */
        UiModuleNode: {
            /** Id */
            id: string;
            /** Parent Id */
            parent_id?: string | null;
            /** Name */
            name: string;
            /**
             * Sort
             * @default 0
             */
            sort: number;
            /**
             * Status
             * @default normal
             */
            status: string;
            /**
             * Count
             * @default 0
             */
            count: number;
            /**
             * Element Count
             * @default 0
             */
            element_count: number;
            /**
             * Case Count
             * @default 0
             */
            case_count: number;
            /**
             * Children
             * @default []
             */
            children: components["schemas"]["UiModuleNode"][];
        };
        /** UiModulePurgeOut */
        UiModulePurgeOut: {
            /**
             * Ok
             * @default true
             */
            ok: boolean;
            /**
             * Purged Modules
             * @default 0
             */
            purged_modules: number;
            /**
             * Detached Elements
             * @default 0
             */
            detached_elements: number;
            /**
             * Detached Cases
             * @default 0
             */
            detached_cases: number;
        };
        /** UiRunEnqueueOut */
        UiRunEnqueueOut: {
            /** Run Id */
            run_id: string;
            /**
             * Status
             * @default queued
             */
            status: string;
        };
        /** UserCreateIn */
        UserCreateIn: {
            /** Account */
            account: string;
            /** Name */
            name: string;
            /** Password */
            password: string;
            /** Email */
            email?: string | null;
            /**
             * Is System Admin
             * @default false
             */
            is_system_admin: boolean;
        };
        /** UserImportCommitIn */
        UserImportCommitIn: {
            /** Items */
            items: components["schemas"]["UserImportCommitItem"][];
            /** Initial Password */
            initial_password: string;
            /**
             * Is System Admin
             * @default false
             */
            is_system_admin: boolean;
        };
        /** UserImportCommitItem */
        UserImportCommitItem: {
            /** Line */
            line: number;
            /**
             * Account
             * @default
             */
            account: string;
            /**
             * Name
             * @default
             */
            name: string;
            /** Email */
            email?: string | null;
            /**
             * Strategy
             * @default create
             */
            strategy: string;
        };
        /** UserImportCommitOut */
        UserImportCommitOut: {
            /** Ok */
            ok: boolean;
            /** Created */
            created: number;
            /** Skipped */
            skipped: number;
            /** Failed */
            failed: number;
            /**
             * Failures
             * @default []
             */
            failures: components["schemas"]["UserImportRowOutcome"][];
            /**
             * Skipped Detail
             * @default []
             */
            skipped_detail: components["schemas"]["UserImportRowOutcome"][];
            /**
             * Produced
             * @default []
             */
            produced: {
                [key: string]: string;
            }[];
        };
        /** UserImportPreviewIn */
        UserImportPreviewIn: {
            /**
             * Text
             * @default
             */
            text: string;
        };
        /** UserImportPreviewItem */
        UserImportPreviewItem: {
            /** Line */
            line: number;
            /** Account */
            account: string;
            /** Name */
            name: string;
            /** Email */
            email?: string | null;
            /** Exists */
            exists: boolean;
        };
        /** UserImportPreviewOut */
        UserImportPreviewOut: {
            /** New Count */
            new_count: number;
            /** Conflict Count */
            conflict_count: number;
            /**
             * Items
             * @default []
             */
            items: components["schemas"]["UserImportPreviewItem"][];
            /**
             * Errors
             * @default []
             */
            errors: string[];
        };
        /** UserImportRowOutcome */
        UserImportRowOutcome: {
            /** Line */
            line: number;
            /** Account */
            account: string;
            /** Reason */
            reason: string;
        };
        /** UserOut */
        UserOut: {
            /** Id */
            id: string;
            /** Account */
            account: string;
            /** Name */
            name: string;
            /** Email */
            email?: string | null;
            /**
             * Is System Admin
             * @default false
             */
            is_system_admin: boolean;
            /**
             * Status
             * @default active
             */
            status: string;
            /** Created At */
            created_at?: string | null;
        };
        /** UserUsageRow */
        UserUsageRow: {
            /** User Id */
            user_id: string;
            /** User Name */
            user_name: string;
            /**
             * Sessions
             * @default 0
             */
            sessions: number;
            /**
             * Turns
             * @default 0
             */
            turns: number;
            /** Input Tokens */
            input_tokens?: number | null;
            /** Output Tokens */
            output_tokens?: number | null;
            /** Total Tokens */
            total_tokens?: number | null;
        };
        /** ValidationError */
        ValidationError: {
            /** Location */
            loc: (string | number)[];
            /** Message */
            msg: string;
            /** Error Type */
            type: string;
            /** Input */
            input?: unknown;
            /** Context */
            ctx?: Record<string, never>;
        };
        /** ViewCreateIn */
        ViewCreateIn: {
            /** Project Id */
            project_id: string;
            /** View Type */
            view_type: string;
            /** Name */
            name: string;
            /** Conditions */
            conditions: {
                [key: string]: unknown;
            };
        };
        /** ViewOut */
        ViewOut: {
            /** Id */
            id: string;
            /** Project Id */
            project_id: string;
            /** View Type */
            view_type: string;
            /** Name */
            name: string;
            /** Conditions */
            conditions: {
                [key: string]: unknown;
            };
            /** Pos */
            pos: number;
            /** Updated At */
            updated_at: string;
        };
        /** adb_case_debug_body */
        adb_case_debug_body: {
            /** Project Id */
            project_id: string;
        };
        /** adb_case_delete_body */
        adb_case_delete_body: {
            /** Project Id */
            project_id: string;
            /**
             * Force
             * @default false
             */
            force: boolean;
        };
        /** adb_case_purge_body */
        adb_case_purge_body: {
            /** Project Id */
            project_id: string;
            /** Confirm Name */
            confirm_name: string;
        };
        /** adb_case_restore_body */
        adb_case_restore_body: {
            /** Project Id */
            project_id: string;
        };
        /** adb_case_run_body */
        adb_case_run_body: {
            /** Project Id */
            project_id: string;
        };
        /** adb_case_update_body */
        adb_case_update_body: {
            /** Project Id */
            project_id: string;
            /** Name */
            name?: string | null;
            /** Priority */
            priority?: string | null;
            /** Enabled */
            enabled?: boolean | null;
            /** Steps */
            steps?: {
                [key: string]: unknown;
            }[] | null;
            /**
             * Steps Set
             * @default false
             */
            steps_set: boolean;
            /** Module Id */
            module_id?: string | null;
            /**
             * Module Set
             * @default false
             */
            module_set: boolean;
            /** Default Device */
            default_device?: string | null;
            /**
             * Default Device Set
             * @default false
             */
            default_device_set: boolean;
            /** Project Public */
            project_public?: boolean | null;
        };
        /** adb_device_delete_body */
        adb_device_delete_body: {
            /** Project Id */
            project_id: string;
        };
        /** adb_device_force_release_body */
        adb_device_force_release_body: {
            /** Project Id */
            project_id: string;
        };
        /** adb_device_purge_body */
        adb_device_purge_body: {
            /** Project Id */
            project_id: string;
            /** Confirm Name */
            confirm_name: string;
            /**
             * Detach Referencing
             * @default false
             */
            detach_referencing: boolean;
        };
        /** adb_device_reconnect_body */
        adb_device_reconnect_body: {
            /** Project Id */
            project_id: string;
        };
        /** adb_device_restore_body */
        adb_device_restore_body: {
            /** Project Id */
            project_id: string;
        };
        /** adb_device_test_body */
        adb_device_test_body: {
            /** Project Id */
            project_id: string;
        };
        /** adb_device_update_body */
        adb_device_update_body: {
            /** Project Id */
            project_id: string;
            /** Name */
            name?: string | null;
            /** Serial */
            serial?: string | null;
            /** Enabled */
            enabled?: boolean | null;
            /** Project Public */
            project_public?: boolean | null;
        };
        /** adb_module_delete_body */
        adb_module_delete_body: {
            /** Project Id */
            project_id: string;
        };
        /** adb_module_purge_body */
        adb_module_purge_body: {
            /** Project Id */
            project_id: string;
            /** Confirm Name */
            confirm_name: string;
        };
        /** adb_module_restore_body */
        adb_module_restore_body: {
            /** Project Id */
            project_id: string;
        };
        /** adb_module_update_body */
        adb_module_update_body: {
            /** Project Id */
            project_id: string;
            /** Name */
            name?: string | null;
            /** Sort */
            sort?: number | null;
            /** Parent Id */
            parent_id?: string | null;
        };
        /** api_case_delete_body */
        api_case_delete_body: {
            /** Project Id */
            project_id: string;
            /**
             * Force
             * @default false
             */
            force: boolean;
        };
        /** api_case_purge_body */
        api_case_purge_body: {
            /** Project Id */
            project_id: string;
            /** Confirm Name */
            confirm_name: string;
        };
        /** api_case_restore_body */
        api_case_restore_body: {
            /** Project Id */
            project_id: string;
        };
        /** api_case_update_body */
        api_case_update_body: {
            /** Project Id */
            project_id: string;
            /** Name */
            name?: string | null;
            /** Priority */
            priority?: string | null;
            request?: components["schemas"]["CaseOverlay"] | null;
            /** Assertions */
            assertions?: components["schemas"]["Assertion"][] | null;
            /**
             * Request Unset
             * @default []
             */
            request_unset: string[];
            /** Dataset Id */
            dataset_id?: string | null;
            /**
             * Dataset Set
             * @default false
             */
            dataset_set: boolean;
            /** Sort */
            sort?: number | null;
            /** Project Public */
            project_public?: boolean | null;
        };
        /** api_definition_delete_body */
        api_definition_delete_body: {
            /** Project Id */
            project_id: string;
            /**
             * Force
             * @default false
             */
            force: boolean;
        };
        /** api_definition_purge_body */
        api_definition_purge_body: {
            /** Project Id */
            project_id: string;
            /** Confirm Name */
            confirm_name: string;
        };
        /** api_definition_restore_body */
        api_definition_restore_body: {
            /** Project Id */
            project_id: string;
        };
        /** api_definition_update_body */
        api_definition_update_body: {
            /** Project Id */
            project_id: string;
            /** Name */
            name?: string | null;
            /** Path */
            path?: string | null;
            request?: components["schemas"]["RequestObject"] | null;
            /** Module Id */
            module_id?: string | null;
            /** Project Public */
            project_public?: boolean | null;
            /** Version */
            version: number;
        };
        /** api_module_delete_body */
        api_module_delete_body: {
            /** Project Id */
            project_id: string;
        };
        /** api_module_purge_body */
        api_module_purge_body: {
            /** Project Id */
            project_id: string;
            /** Confirm Name */
            confirm_name: string;
        };
        /** api_module_restore_body */
        api_module_restore_body: {
            /** Project Id */
            project_id: string;
        };
        /** api_module_update_body */
        api_module_update_body: {
            /** Project Id */
            project_id: string;
            /** Name */
            name?: string | null;
            /** Sort */
            sort?: number | null;
            /** Parent Id */
            parent_id?: string | null;
        };
        /** data_set_delete_body */
        data_set_delete_body: {
            /** Project Id */
            project_id: string;
        };
        /** data_set_update_body */
        data_set_update_body: {
            /** Project Id */
            project_id: string;
            /** Name */
            name?: string | null;
            /** Columns */
            columns?: string[] | null;
            /** Rows */
            rows?: string[][] | null;
        };
        /** env_delete_body */
        env_delete_body: {
            /** Project Id */
            project_id: string;
        };
        /** env_update_body */
        env_update_body: {
            /** Project Id */
            project_id: string;
            /** Name */
            name?: string | null;
            /** Position */
            position?: number | null;
            /** Config */
            config?: {
                [key: string]: unknown;
            } | null;
        };
        /** model_cfg_delete_body */
        model_cfg_delete_body: Record<string, never>;
        /** model_cfg_probe_body */
        model_cfg_probe_body: Record<string, never>;
        /** model_cfg_update_body */
        model_cfg_update_body: {
            /** Name */
            name?: string | null;
            /** Base Url */
            base_url?: string | null;
            /** Model Name */
            model_name?: string | null;
            /** Api Key */
            api_key?: string | null;
            /** Context Window */
            context_window?: number | null;
            /** Max Output */
            max_output?: number | null;
            /** Supports Thinking */
            supports_thinking?: boolean | null;
            /** Thinking Levels */
            thinking_levels?: string[] | null;
            /** Supports Vision */
            supports_vision?: boolean | null;
            /** Supports Tools */
            supports_tools?: boolean | null;
            /** Temperature Default */
            temperature_default?: number | null;
            /** Enabled */
            enabled?: boolean | null;
            /** Is Default */
            is_default?: boolean | null;
        };
        /** notify_channel_delete_body */
        notify_channel_delete_body: Record<string, never>;
        /** notify_channel_test_body */
        notify_channel_test_body: Record<string, never>;
        /** notify_channel_update_body */
        notify_channel_update_body: {
            /** Name */
            name?: string | null;
            /** Config */
            config?: {
                [key: string]: unknown;
            } | null;
        };
        /** plan_archive_body */
        plan_archive_body: {
            /** Project Id */
            project_id: string;
        };
        /** plan_delete_body */
        plan_delete_body: {
            /** Project Id */
            project_id: string;
        };
        /** plan_link_create_body */
        plan_link_create_body: {
            /** Project Id */
            project_id: string;
            /** Subject Type */
            subject_type: string;
            /** Subject Id */
            subject_id: string;
            /** Env Id */
            env_id?: string | null;
        };
        /** plan_link_delete_body */
        plan_link_delete_body: {
            /** Project Id */
            project_id: string;
        };
        /** plan_link_update_body */
        plan_link_update_body: {
            /** Project Id */
            project_id: string;
            /** Env Id */
            env_id?: string | null;
            /**
             * Clear Env
             * @default false
             */
            clear_env: boolean;
        };
        /** plan_report_create_body */
        plan_report_create_body: {
            /** Project Id */
            project_id: string;
            /** Name */
            name?: string | null;
        };
        /** plan_report_delete_body */
        plan_report_delete_body: {
            /** Project Id */
            project_id: string;
        };
        /** plan_update_body */
        plan_update_body: {
            /** Project Id */
            project_id: string;
            /** Name */
            name?: string | null;
            /** Description */
            description?: string | null;
            /** Archived */
            archived?: boolean | null;
        };
        /** role_delete_body */
        role_delete_body: {
            /** Project Id */
            project_id: string;
        };
        /** role_update_body */
        role_update_body: {
            /** Project Id */
            project_id: string;
            /** Name */
            name?: string | null;
            /** Perms */
            perms?: string[] | null;
        };
        /** run_cancel_body */
        run_cancel_body: {
            /** Project Id */
            project_id: string;
        };
        /** run_rerun_step_body */
        run_rerun_step_body: {
            /** Project Id */
            project_id: string;
            /** Step Key */
            step_key: string;
            /** Row No */
            row_no?: number | null;
            /** Env Id */
            env_id?: string | null;
        };
        /** saved_view_delete_body */
        saved_view_delete_body: {
            /** Project Id */
            project_id: string;
            /** View Type */
            view_type: string;
        };
        /** saved_view_update_body */
        saved_view_update_body: {
            /** Project Id */
            project_id: string;
            /** View Type */
            view_type: string;
            /** Name */
            name?: string | null;
            /** Conditions */
            conditions?: {
                [key: string]: unknown;
            } | null;
        };
        /** scenario_debug_body */
        scenario_debug_body: {
            /** Project Id */
            project_id: string;
            /** Graph */
            graph: {
                [key: string]: unknown;
            };
            /** Variables */
            variables?: {
                [key: string]: string;
            } | null;
            /** Env Id */
            env_id?: string | null;
            /** Fail Fast */
            fail_fast?: boolean | null;
        };
        /** scenario_delete_body */
        scenario_delete_body: {
            /** Project Id */
            project_id: string;
        };
        /** scenario_duplicate_body */
        scenario_duplicate_body: {
            /** Project Id */
            project_id: string;
            /** Name */
            name?: string | null;
            /** Module Id */
            module_id?: string | null;
        };
        /** scenario_module_delete_body */
        scenario_module_delete_body: {
            /** Project Id */
            project_id: string;
        };
        /** scenario_module_purge_body */
        scenario_module_purge_body: {
            /** Project Id */
            project_id: string;
            /** Confirm Name */
            confirm_name: string;
        };
        /** scenario_module_restore_body */
        scenario_module_restore_body: {
            /** Project Id */
            project_id: string;
        };
        /** scenario_module_update_body */
        scenario_module_update_body: {
            /** Project Id */
            project_id: string;
            /** Name */
            name?: string | null;
            /** Sort */
            sort?: number | null;
            /** Parent Id */
            parent_id?: string | null;
        };
        /** scenario_purge_body */
        scenario_purge_body: {
            /** Project Id */
            project_id: string;
            /** Confirm Name */
            confirm_name: string;
        };
        /** scenario_restore_body */
        scenario_restore_body: {
            /** Project Id */
            project_id: string;
        };
        /** scenario_run_body */
        scenario_run_body: {
            /** Project Id */
            project_id: string;
            /** Env Id */
            env_id?: string | null;
        };
        /** scenario_update_body */
        scenario_update_body: {
            /** Project Id */
            project_id: string;
            /** Version */
            version: number;
            /** Name */
            name?: string | null;
            /** Priority */
            priority?: string | null;
            /** Tags */
            tags?: string[] | null;
            /** Module Id */
            module_id?: string | null;
            /**
             * Module Set
             * @default false
             */
            module_set?: boolean;
            /** Step Graph */
            step_graph?: {
                [key: string]: unknown;
            } | null;
            /** Variables */
            variables?: {
                [key: string]: string;
            } | null;
            /** Fail Fast */
            fail_fast?: boolean | null;
            /** Max Runtime Ms */
            max_runtime_ms?: number | null;
            /**
             * Max Runtime Set
             * @default false
             */
            max_runtime_set?: boolean;
            /** Common Assertions */
            common_assertions?: {
                [key: string]: unknown;
            }[] | null;
            /**
             * Common Assertions Set
             * @default false
             */
            common_assertions_set?: boolean;
            /** Env Id */
            env_id?: string | null;
            /**
             * Env Set
             * @default false
             */
            env_set?: boolean;
            /** Project Public */
            project_public?: boolean | null;
        };
        /** schedule_task_delete_body */
        schedule_task_delete_body: {
            /** Project Id */
            project_id: string;
        };
        /** schedule_task_update_body */
        schedule_task_update_body: {
            /** Project Id */
            project_id: string;
            /** Name */
            name?: string | null;
            /** Subject Type */
            subject_type?: string | null;
            /** Subject Id */
            subject_id?: string | null;
            /** Cron */
            cron?: string | null;
            /** Env Id */
            env_id?: string | null;
            /** Enabled */
            enabled?: number | null;
            /** Notify Channel Ids */
            notify_channel_ids?: string[] | null;
        };
        /** ui_case_debug_body */
        ui_case_debug_body: {
            /** Project Id */
            project_id: string;
        };
        /** ui_case_delete_body */
        ui_case_delete_body: {
            /** Project Id */
            project_id: string;
            /**
             * Force
             * @default false
             */
            force: boolean;
        };
        /** ui_case_purge_body */
        ui_case_purge_body: {
            /** Project Id */
            project_id: string;
            /** Confirm Name */
            confirm_name: string;
        };
        /** ui_case_restore_body */
        ui_case_restore_body: {
            /** Project Id */
            project_id: string;
        };
        /** ui_case_run_body */
        ui_case_run_body: {
            /** Project Id */
            project_id: string;
        };
        /** ui_case_update_body */
        ui_case_update_body: {
            /** Project Id */
            project_id: string;
            /** Name */
            name?: string | null;
            /** Priority */
            priority?: string | null;
            /** Enabled */
            enabled?: boolean | null;
            /** Steps */
            steps?: {
                [key: string]: unknown;
            }[] | null;
            /**
             * Steps Set
             * @default false
             */
            steps_set: boolean;
            /** Module Id */
            module_id?: string | null;
            /**
             * Module Set
             * @default false
             */
            module_set: boolean;
            /** Env Id */
            env_id?: string | null;
            /**
             * Env Set
             * @default false
             */
            env_set: boolean;
            /** Project Public */
            project_public?: boolean | null;
        };
        /** ui_element_delete_body */
        ui_element_delete_body: {
            /** Project Id */
            project_id: string;
        };
        /** ui_element_purge_body */
        ui_element_purge_body: {
            /** Project Id */
            project_id: string;
            /** Confirm Name */
            confirm_name: string;
        };
        /** ui_element_restore_body */
        ui_element_restore_body: {
            /** Project Id */
            project_id: string;
        };
        /** ui_element_update_body */
        ui_element_update_body: {
            /** Project Id */
            project_id: string;
            /** Name */
            name?: string | null;
            /** Locator Type */
            locator_type?: string | null;
            /** Locator */
            locator?: string | null;
            /** Comment */
            comment?: string | null;
            /** Module Id */
            module_id?: string | null;
            /**
             * Module Set
             * @default false
             */
            module_set: boolean;
            /** Project Public */
            project_public?: boolean | null;
        };
        /** ui_module_delete_body */
        ui_module_delete_body: {
            /** Project Id */
            project_id: string;
        };
        /** ui_module_purge_body */
        ui_module_purge_body: {
            /** Project Id */
            project_id: string;
            /** Confirm Name */
            confirm_name: string;
        };
        /** ui_module_restore_body */
        ui_module_restore_body: {
            /** Project Id */
            project_id: string;
        };
        /** ui_module_update_body */
        ui_module_update_body: {
            /** Project Id */
            project_id: string;
            /** Name */
            name?: string | null;
            /** Sort */
            sort?: number | null;
            /** Parent Id */
            parent_id?: string | null;
        };
        /** user_status_body */
        user_status_body: {
            /** Status */
            status: string;
        };
        /** user_update_body */
        user_update_body: {
            /** Name */
            name?: string | null;
            /** Email */
            email?: string | null;
            /** Password */
            password?: string | null;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    login_api_v1_auth_login_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LoginIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LoginOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    refresh_api_v1_auth_refresh_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RefreshOut"];
                };
            };
        };
    };
    logout_api_v1_auth_logout_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: boolean;
                    };
                };
            };
        };
    };
    me_api_v1_auth_me_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserOut"];
                };
            };
        };
    };
    roles_api_v1_roles_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    list_projects_api_v1_projects_get: {
        parameters: {
            query?: {
                cursor?: string | null;
                size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_project_api_v1_projects_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProjectIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_project_api_v1_projects__project_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_project_api_v1_projects__project_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProjectUpdateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_members_api_v1_projects__project_id__members_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    set_member_api_v1_projects__project_id__members__user_id__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MemberIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    remove_member_api_v1_projects__project_id__members__user_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_agent_tools_api_v1_agent_tools_get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_session_api_v1_agent_sessions_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SessionIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_messages_api_v1_agent_sessions__session_id__messages_get: {
        parameters: {
            query?: {
                cursor?: number;
                size?: number;
            };
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_message_api_v1_agent_sessions__session_id__messages_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MessageIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    interrupt_api_v1_agent_sessions__session_id__interrupt_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InterruptIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    events_api_v1_events_agent__session_id__get: {
        parameters: {
            query?: {
                cursor?: number | null;
            };
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    run_events_api_v1_events_run__run_id__get: {
        parameters: {
            query: {
                project_id: string;
                cursor?: number | null;
            };
            header?: never;
            path: {
                run_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_api_case_list_api_v1_api_cases_get: {
        parameters: {
            query: {
                project_id: string;
                definition_id?: string | null;
                recycled?: boolean;
                cursor?: string | null;
                size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_api_case_create_api_v1_api_cases_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CaseCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CaseOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_api_case_get_api_v1_api_cases__case_id__get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CaseOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_api_case_update_api_v1_api_cases__case_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["api_case_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CaseOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_api_case_delete_api_v1_api_cases__case_id__delete_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["api_case_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_api_case_restore_api_v1_api_cases__case_id__restore_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["api_case_restore_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_api_case_purge_api_v1_api_cases__case_id__purge_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["api_case_purge_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_data_set_list_api_v1_datasets_get: {
        parameters: {
            query: {
                project_id: string;
                cursor?: string | null;
                size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_data_set_create_api_v1_datasets_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DatasetCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DatasetOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_data_set_update_api_v1_datasets__dataset_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                dataset_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["data_set_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DatasetOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_data_set_delete_api_v1_datasets__dataset_id__delete_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                dataset_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["data_set_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_api_import_preview_api_v1_api_import_preview_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ImportPreviewIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_api_import_commit_api_v1_api_import_commit_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ImportCommitIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_api_export_api_v1_api_export_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ApiExportIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiExportOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_api_module_tree_api_v1_api_modules_get: {
        parameters: {
            query: {
                project_id: string;
                include_recycled?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_api_module_create_api_v1_api_modules_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ModuleCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModuleNode"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_api_module_update_api_v1_api_modules__module_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                module_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["api_module_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModuleNode"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_api_module_delete_api_v1_api_modules__module_id__delete_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                module_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["api_module_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_api_module_purge_api_v1_api_modules__module_id__purge_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                module_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["api_module_purge_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_api_module_restore_api_v1_api_modules__module_id__restore_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                module_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["api_module_restore_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_run_record_list_api_v1_runs_get: {
        parameters: {
            query: {
                project_id: string;
                subject_id?: string | null;
                trigger?: string | null;
                status?: string | null;
                subject_type?: string | null;
                cursor?: string | null;
                current?: number | null;
                size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_run_get_api_v1_runs__run_id__get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path: {
                run_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_api_definition_list_api_v1_api_definitions_get: {
        parameters: {
            query: {
                project_id: string;
                recycled?: boolean;
                cursor?: string | null;
                current?: number | null;
                size?: number;
                filter?: string | null;
                module_ids?: string[] | null;
                keyword?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_api_definition_create_api_v1_api_definitions_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ApiDefCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiDefOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_api_definition_get_api_v1_api_definitions__definition_id__get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path: {
                definition_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiDefOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_api_definition_update_api_v1_api_definitions__definition_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                definition_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["api_definition_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiDefOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_api_definition_delete_api_v1_api_definitions__definition_id__delete_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                definition_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["api_definition_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_api_definition_purge_api_v1_api_definitions__definition_id__purge_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                definition_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["api_definition_purge_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_api_definition_restore_api_v1_api_definitions__definition_id__restore_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                definition_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["api_definition_restore_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_api_debug_api_v1_api_debug_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ApiDebugIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DebugOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_audit_list_api_v1_audit_get: {
        parameters: {
            query?: {
                project_id?: string | null;
                entry?: string | null;
                action?: string | null;
                user_id?: string | null;
                ok?: boolean | null;
                ts_from?: string | null;
                ts_to?: string | null;
                cursor?: string | null;
                size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_env_list_api_v1_envs_get: {
        parameters: {
            query: {
                project_id: string;
                cursor?: string | null;
                size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_env_create_api_v1_envs_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EnvCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EnvOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_env_delete_api_v1_envs__env_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                env_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["env_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OkOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_env_update_api_v1_envs__env_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                env_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["env_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EnvOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_global_config_get_api_v1_envs_global_config_get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_global_config_update_api_v1_envs_global_config_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GlobalConfigUpdateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OkOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_artifact_download_api_v1_artifacts__run_id___name__get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path: {
                run_id: string;
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_report_list_api_v1_reports_get: {
        parameters: {
            query: {
                project_id: string;
                subject_id?: string | null;
                trigger?: string | null;
                status?: string | null;
                subject_type?: string | null;
                env_id?: string | null;
                created_by?: string | null;
                since?: string | null;
                until?: string | null;
                include_debug?: boolean;
                cursor?: string | null;
                current?: number | null;
                size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_report_get_api_v1_reports__run_id__get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path: {
                run_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_report_step_detail_api_v1_reports__run_id__steps_get: {
        parameters: {
            query: {
                project_id: string;
                step_key: string;
                row_no?: number;
            };
            header?: never;
            path: {
                run_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_project_member_candidates_api_v1_project_member_candidates_get: {
        parameters: {
            query: {
                project_id: string;
                q?: string;
                size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_user_list_api_v1_system_users_get: {
        parameters: {
            query?: {
                cursor?: string | null;
                size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_user_create_api_v1_system_users_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UserCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_user_update_api_v1_system_users__user_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["user_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_user_status_api_v1_system_users__user_id__status_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["user_status_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_password_change_self_api_v1_auth_password_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PasswordChangeIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OkOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_role_template_list_api_v1_role_templates_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    post_user_import_preview_api_v1_system_users_import_preview_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UserImportPreviewIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserImportPreviewOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_user_import_commit_api_v1_system_users_import_commit_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UserImportCommitIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserImportCommitOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_role_custom_list_api_v1_custom_roles_get: {
        parameters: {
            query: {
                project_id: string;
                cursor?: string | null;
                size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_role_create_api_v1_custom_roles_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RoleCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CustomRoleOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_role_update_api_v1_custom_roles__code__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                code: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["role_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CustomRoleOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_role_delete_api_v1_custom_roles__code__delete_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                code: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["role_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OkOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_role_perm_tree_api_v1_role_perm_tree_get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RolePermTreeOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_model_cfg_list_api_v1_model_cfgs_get: {
        parameters: {
            query?: {
                model_type?: ("CHAT" | "EMBEDDING") | null;
                cursor?: string | null;
                size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_model_cfg_create_api_v1_model_cfgs_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CfgCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CfgOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_model_cfg_delete_api_v1_model_cfgs__cfg_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                cfg_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["model_cfg_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OkOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_model_cfg_update_api_v1_model_cfgs__cfg_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                cfg_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["model_cfg_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CfgOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_model_cfg_probe_api_v1_model_cfgs__cfg_id__probe_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                cfg_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["model_cfg_probe_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProbeOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_scenario_export_api_v1_scenario_export_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ScenarioExportIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScenarioExportOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_scenario_module_tree_api_v1_scenario_modules_get: {
        parameters: {
            query: {
                project_id: string;
                include_recycled?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_scenario_module_create_api_v1_scenario_modules_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ScenarioModuleCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScenarioModuleNode"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_scenario_module_update_api_v1_scenario_modules__module_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                module_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["scenario_module_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScenarioModuleNode"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_scenario_module_delete_api_v1_scenario_modules__module_id__delete_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                module_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["scenario_module_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_scenario_module_restore_api_v1_scenario_modules__module_id__restore_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                module_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["scenario_module_restore_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_scenario_module_purge_api_v1_scenario_modules__module_id__purge_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                module_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["scenario_module_purge_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_scenario_list_api_v1_scenarios_get: {
        parameters: {
            query: {
                project_id: string;
                module_id?: string | null;
                recycled?: boolean;
                cursor?: string | null;
                current?: number | null;
                size?: number;
                module_ids?: string[] | null;
                keyword?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_scenario_create_api_v1_scenarios_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ScenarioCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScenarioOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_scenario_get_api_v1_scenarios__scenario_id__get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path: {
                scenario_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScenarioOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_scenario_update_api_v1_scenarios__scenario_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                scenario_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["scenario_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScenarioOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_scenario_delete_api_v1_scenarios__scenario_id__delete_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                scenario_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["scenario_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_scenario_restore_api_v1_scenarios__scenario_id__restore_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                scenario_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["scenario_restore_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScenarioOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_scenario_purge_api_v1_scenarios__scenario_id__purge_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                scenario_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["scenario_purge_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_scenario_duplicate_api_v1_scenarios__scenario_id__duplicate_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                scenario_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["scenario_duplicate_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScenarioOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_scenario_batch_move_api_v1_scenario_batch_move_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ScenarioBatchMoveIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_scenario_references_api_v1_scenario_references_get: {
        parameters: {
            query: {
                project_id: string;
                case_id?: string | null;
                definition_id?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScenarioReferencesOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_scenario_run_api_v1_scenarios__scenario_id__run_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                scenario_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["scenario_run_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunEnqueueOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_scenario_debug_api_v1_scenarios__scenario_id__debug_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                scenario_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["scenario_debug_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunEnqueueOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_run_cancel_api_v1_runs__run_id__cancel_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                run_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["run_cancel_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunCancelOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_run_rerun_step_api_v1_runs__run_id__rerun_step_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                run_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["run_rerun_step_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RerunStepOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_search_assets_api_v1_search_assets_get: {
        parameters: {
            query: {
                project_id: string;
                q: string;
                kind?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SearchAssetsOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_filter_meta_api_v1_filter_meta_get: {
        parameters: {
            query: {
                project_id: string;
                view_type?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FilterMetaOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_saved_view_list_api_v1_saved_views_get: {
        parameters: {
            query: {
                project_id: string;
                view_type: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_saved_view_create_api_v1_saved_views_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ViewCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ViewOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_saved_view_delete_api_v1_saved_views__view_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                view_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["saved_view_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_saved_view_update_api_v1_saved_views__view_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                view_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["saved_view_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ViewOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_plan_list_api_v1_plans_get: {
        parameters: {
            query: {
                project_id: string;
                current?: number;
                size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_plan_create_api_v1_plans_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlanCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_plan_get_api_v1_plans__plan_id__get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path: {
                plan_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_plan_delete_api_v1_plans__plan_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                plan_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["plan_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OkOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_plan_update_api_v1_plans__plan_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                plan_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["plan_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_plan_archive_api_v1_plans__plan_id__archive_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                plan_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["plan_archive_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_plan_link_list_api_v1_plans__plan_id__case_links_get: {
        parameters: {
            query: {
                project_id: string;
                current?: number;
                size?: number;
            };
            header?: never;
            path: {
                plan_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_plan_link_create_api_v1_plans__plan_id__case_links_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                plan_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["plan_link_create_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanLinkOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_plan_link_delete_api_v1_plans__plan_id__case_links__link_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                plan_id: string;
                link_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["plan_link_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OkOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_plan_link_update_api_v1_plans__plan_id__case_links__link_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                plan_id: string;
                link_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["plan_link_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanLinkOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_plan_status_api_v1_plans__plan_id__status_get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path: {
                plan_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanStatusOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_plan_report_list_api_v1_plans__plan_id__reports_get: {
        parameters: {
            query: {
                project_id: string;
                current?: number;
                size?: number;
            };
            header?: never;
            path: {
                plan_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_plan_report_create_api_v1_plans__plan_id__reports_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                plan_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["plan_report_create_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanReportOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_plan_report_get_api_v1_plan_reports__report_id__get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path: {
                report_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanReportOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_plan_report_delete_api_v1_plan_reports__report_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                report_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["plan_report_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OkOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_plan_report_item_list_api_v1_plan_reports__report_id__items_get: {
        parameters: {
            query: {
                project_id: string;
                current?: number;
                size?: number;
            };
            header?: never;
            path: {
                report_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_ui_module_tree_api_v1_ui_modules_get: {
        parameters: {
            query: {
                project_id: string;
                include_recycled?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_ui_module_create_api_v1_ui_modules_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UiModuleCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UiModuleNode"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_ui_module_update_api_v1_ui_modules__module_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                module_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ui_module_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UiModuleNode"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_ui_module_delete_api_v1_ui_modules__module_id__delete_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                module_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ui_module_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_ui_module_restore_api_v1_ui_modules__module_id__restore_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                module_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ui_module_restore_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_ui_module_purge_api_v1_ui_modules__module_id__purge_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                module_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ui_module_purge_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UiModulePurgeOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_ui_element_list_api_v1_ui_elements_get: {
        parameters: {
            query: {
                project_id: string;
                module_id?: string | null;
                unfiled_only?: boolean;
                module_ids?: string[] | null;
                keyword?: string | null;
                recycled?: boolean;
                cursor?: string | null;
                current?: number | null;
                size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_ui_element_create_api_v1_ui_elements_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UiElementCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UiElementOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_ui_element_get_api_v1_ui_elements__element_id__get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path: {
                element_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UiElementOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_ui_element_update_api_v1_ui_elements__element_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                element_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ui_element_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UiElementOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_ui_element_delete_api_v1_ui_elements__element_id__delete_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                element_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ui_element_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_ui_element_restore_api_v1_ui_elements__element_id__restore_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                element_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ui_element_restore_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UiElementOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_ui_element_purge_api_v1_ui_elements__element_id__purge_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                element_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ui_element_purge_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_ui_case_list_api_v1_ui_cases_get: {
        parameters: {
            query: {
                project_id: string;
                module_id?: string | null;
                unfiled_only?: boolean;
                recycled?: boolean;
                cursor?: string | null;
                current?: number | null;
                size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_ui_case_create_api_v1_ui_cases_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UiCaseCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UiCaseOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_ui_case_get_api_v1_ui_cases__case_id__get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UiCaseOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_ui_case_update_api_v1_ui_cases__case_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ui_case_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UiCaseOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_ui_case_delete_api_v1_ui_cases__case_id__delete_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ui_case_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_ui_case_restore_api_v1_ui_cases__case_id__restore_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ui_case_restore_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UiCaseOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_ui_case_purge_api_v1_ui_cases__case_id__purge_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ui_case_purge_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_ui_case_references_api_v1_ui_case_references_get: {
        parameters: {
            query: {
                project_id: string;
                case_id: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UiCaseReferencesOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_ui_case_debug_api_v1_ui_cases__case_id__debug_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ui_case_debug_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UiDebugOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_ui_case_run_api_v1_ui_cases__case_id__run_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ui_case_run_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UiRunEnqueueOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_adb_module_tree_api_v1_adb_modules_get: {
        parameters: {
            query: {
                project_id: string;
                include_recycled?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_adb_module_create_api_v1_adb_modules_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdbModuleCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdbModuleNode"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_adb_module_update_api_v1_adb_modules__module_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                module_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["adb_module_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdbModuleNode"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_adb_module_delete_api_v1_adb_modules__module_id__delete_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                module_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["adb_module_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_adb_module_restore_api_v1_adb_modules__module_id__restore_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                module_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["adb_module_restore_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_adb_module_purge_api_v1_adb_modules__module_id__purge_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                module_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["adb_module_purge_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdbModulePurgeOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_adb_case_list_api_v1_adb_cases_get: {
        parameters: {
            query: {
                project_id: string;
                module_id?: string | null;
                unfiled_only?: boolean;
                recycled?: boolean;
                cursor?: string | null;
                current?: number | null;
                size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_adb_case_create_api_v1_adb_cases_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdbCaseCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdbCaseOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_adb_case_get_api_v1_adb_cases__case_id__get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdbCaseOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_adb_case_update_api_v1_adb_cases__case_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["adb_case_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdbCaseOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_adb_case_delete_api_v1_adb_cases__case_id__delete_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["adb_case_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_adb_case_restore_api_v1_adb_cases__case_id__restore_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["adb_case_restore_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdbCaseOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_adb_case_purge_api_v1_adb_cases__case_id__purge_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["adb_case_purge_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_adb_case_references_api_v1_adb_case_references_get: {
        parameters: {
            query: {
                project_id: string;
                case_id: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdbCaseReferencesOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_adb_case_debug_api_v1_adb_cases__case_id__debug_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["adb_case_debug_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdbDebugOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_adb_case_run_api_v1_adb_cases__case_id__run_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                case_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["adb_case_run_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdbRunEnqueueOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_adb_device_list_api_v1_adb_devices_get: {
        parameters: {
            query: {
                project_id: string;
                recycled?: boolean;
                cursor?: string | null;
                state?: ("offline" | "occupied" | "idle") | null;
                current?: number | null;
                size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_adb_device_create_api_v1_adb_devices_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdbDeviceCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdbDeviceOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_adb_device_get_api_v1_adb_devices__device_id__get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path: {
                device_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdbDeviceOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_adb_device_update_api_v1_adb_devices__device_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["adb_device_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdbDeviceOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_adb_device_occupation_api_v1_adb_devices__device_id__occupation_get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path: {
                device_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdbDeviceOccupationOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_adb_device_force_release_api_v1_adb_devices__device_id__force_release_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["adb_device_force_release_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdbDeviceForceReleaseOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_adb_device_test_api_v1_adb_devices__device_id__test_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["adb_device_test_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdbDeviceTestOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_adb_device_reconnect_api_v1_adb_devices__device_id__reconnect_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["adb_device_reconnect_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdbDeviceOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_adb_device_delete_api_v1_adb_devices__device_id__delete_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["adb_device_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_adb_device_restore_api_v1_adb_devices__device_id__restore_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["adb_device_restore_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdbDeviceOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_adb_device_purge_api_v1_adb_devices__device_id__purge_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["adb_device_purge_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_notify_channel_list_api_v1_notify_channels_get: {
        parameters: {
            query?: {
                type?: string | null;
                cursor?: string | null;
                current?: number | null;
                size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_notify_channel_create_api_v1_notify_channels_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ChannelCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChannelOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_notify_channel_get_api_v1_notify_channels__channel_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                channel_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChannelOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_notify_channel_update_api_v1_notify_channels__channel_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                channel_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["notify_channel_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChannelOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_notify_channel_delete_api_v1_notify_channels__channel_id__delete_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                channel_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["notify_channel_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OkOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_notify_channel_test_api_v1_notify_channels__channel_id__test_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                channel_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["notify_channel_test_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChannelTestOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_schedule_task_list_api_v1_schedule_tasks_get: {
        parameters: {
            query: {
                project_id: string;
                enabled?: number | null;
                cursor?: string | null;
                current?: number | null;
                size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_schedule_task_create_api_v1_schedule_tasks_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TaskCreateIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TaskOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_schedule_task_get_api_v1_schedule_tasks__task_id__get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path: {
                task_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TaskOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_schedule_task_update_api_v1_schedule_tasks__task_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                task_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["schedule_task_update_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TaskOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_schedule_task_delete_api_v1_schedule_tasks__task_id__delete_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                task_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["schedule_task_delete_body"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OkOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_schedule_task_next_5_api_v1_schedule_tasks_next_5_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Next5In"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Next5Out"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_model_usage_stats_api_v1_model_usage_get: {
        parameters: {
            query?: {
                project_id?: string | null;
                model_id?: string | null;
                days?: number | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelUsageOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_workbench_stats_api_v1_workbench_stats_get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    healthz_api_v1_healthz_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: string;
                    };
                };
            };
        };
    };
    readyz_api_v1_readyz_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
}
