# ComfyUI Audio Visualizer - 官方音频节点可视化扩展

一个零侵入式的前端扩展，在 **ComfyUI 官方音频节点**（加载 / 预览 / 保存）中自动挂载实时波形、频谱可视化画布，无需额外节点。

## 提前注意：
1、刷新浏览器，如果播放不了，重新到菜单里调用新的节点，
2、不适合vue 模式

## ✨ 功能特性

- 🧩 **即插即用**：安装后自动作用于官方节点 `LoadAudio`、`SaveAudio(*)`、`PreviewAudio`
- 📊 **实时可视化**：内置三种模式
  - **波形图 (Wave)**: 显示音频时域波形
  - **频谱柱状图 (Bars)**: 显示音频频域频谱
  - **圆形频谱图 (Circular)**: 圆形径向频谱显示
- 🟢 **安全旁路**：只监听播放事件，不修改/暂停官方播放器
- 🎛️ **菜单控制**：右上角弹出菜单可开关可视化、切换模式、调节背景透明度、上传背景图
- 🖼️ **自定义背景**：支持上传图片（自动压缩到 512px 内），也可使用内置渐变背景

<img width="1132" height="629" alt="image" src="https://github.com/user-attachments/assets/1017e02a-1249-420e-938b-e903640e500f" />

## 📦 安装

1. 将本插件放置在 `custom_nodes/ComfyUI-music` 目录下
2. 重启 ComfyUI
3. 无需添加新节点，官方音频节点即会自动出现画布

## 🚀 使用方法

### 适用节点

- `LoadAudio`
- `SaveAudio` / `SaveAudioMP3` / `SaveAudioOpus`
- `PreviewAudio`

只要这些节点中出现了官方播放器（`audioUI`），播放时即可触发可视化。

### 菜单说明（右下角按钮）

| 控件 | 说明 |
| ---- | ---- |
| **Enable visualizer** | 控制是否接入音频并刷新画布，默认勾选 |
| **Waveform / Spectral Bars / Circular** | 切换可视化模式 |
| **Background overlay** | 滑杆调节背景透明度 |
| **Upload image / Clear** | 自定义背景图片（自动压缩至 512px 以内）或恢复内置渐变 |

### 自动可视化逻辑

- 监听官方 `<audio>` 播放器的 `play / pause / ended` 事件
- `play` 时创建 `AudioContext + AnalyserNode`，旁路分析并刷新画布
- `pause / ended` 时停止刷新；不修改/暂停原播放器

## 🎨 自定义背景示例

| 主题 | 建议设置 |
| --- | --- |
| 赛博朋克 | Upload：霓虹城市 / 滑杆 0.3 |
| 暖色系 | Upload：日落天空 / 滑杆 0.25 |
| 清新极简 | 使用内置背景 + Bars 模式 |

## 🔧 技术实现

- **纯前端扩展**：不会新增/修改任何 Python 节点
- **白名单挂载**：仅对白名单官方节点注入画布
- **安全旁路**：使用 Web Audio API (`AudioContext`, `AnalyserNode`) 只读分析音频

## 📋 系统要求

- ComfyUI（已内置音频支持）
- 现代浏览器（支持 Web Audio API）
  - Chrome/Edge: ✅ 完全支持
  - Firefox: ✅ 完全支持
  - Safari: ✅ 完全支持

## 🐛 故障排除

### 可视化不显示
1. 检查浏览器控制台是否有错误
2. 确认音频文件已正确加载
3. 尝试刷新页面

### 音频无法播放
1. 检查音频文件格式是否支持
2. 确认文件路径正确
3. 检查浏览器音频权限

### 性能问题
1. 降低 FFT 大小（如从 4096 降到 2048）
2. 关闭其他占用资源的标签页
3. 使用较简单的可视化模式（wave 模式性能最好）

**享受音频可视化的乐趣！** 🎵✨

## 关于我 | About me

Bilibili：[我的B站主页](https://space.bilibili.com/498399023?spm_id_from=333.1007.0.0)
QQ号：3260561522
wechat微信: DLONG189one





