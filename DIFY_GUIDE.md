# Dify 工作流集成指南

您可以将此应用作为 Dify 工作流中的一个 **HTTP 请求** 节点，实现自动化的文档翻译。

### 1. 节点配置 (HTTP Request Node)

在 Dify 工作流中添加一个 "HTTP Request" 节点，配置如下：

- **URL**: `http://您的服务器IP:3000/api/v1/translate-doc`
- **Method**: `POST`
- **Body Type**: `form-data`

### 2. 参数设置 (Form-Data)

在 Body 中添加以下字段：

| 键 (Key) | 类型 (Type) | 值 (Value) | 说明 |
| :--- | :--- | :--- | :--- |
| `file` | `File` | `{{sys.files[0]}}` | 从 Dify 上传节点获取的文件变量 |
| `target_lang` | `Text` | `Chinese` | 目标语言 (例如: English, Japanese) |
| `provider_id` | `Text` | `ollama` | 提供商 ID (对应 config.json 中的 key，如 gemini, ollama, deepseek) |
| `model_id` | `Text` | `deepseek-r1:8b` | 模型 ID (对应 config.json 中的模型 id) |
| `api_key` | `Text` | `ollama` | 可选。如果不填则使用 config.json 中的默认值 |

### 3. 输出处理

- 该节点会直接返回翻译后的二进制文件流。
- 您可以在 Dify 的后续节点中使用该文件进行存储或发送。

### 4. 方案优势

- **全格式支持**：后端自动处理 .docx, .xlsx, .pptx 的解压、XML 解析和重组。
- **R1 兼容**：后端已内置 `<think>` 标签剥离逻辑，完美支持 DeepSeek-R1。
- **本地化**：如果您的 Dify 和此应用部署在同一局域网，可以实现完全私有化的文档翻译流程。
