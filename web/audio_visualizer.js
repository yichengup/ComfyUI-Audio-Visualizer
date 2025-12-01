/**
 * ComfyUI Audio Visualizer Extension
 * 音频波形实时可视化前端扩展
 * 
 * 功能：
 * - 为官方音频节点（Load/Save/Preview）和未来扩展添加 Canvas 可视化
 * - 支持三种可视化模式：波形图、频谱柱状图、圆形频谱图
 * - 实时显示音频波形
 */

import { app } from "../../scripts/app.js";

// 简单的链式回调函数（如果系统没有提供）
function useChainCallback(originalCallback, ...callbacks) {
    return function(...args) {
        if (originalCallback) {
            originalCallback.apply(this, args);
        }
        for (const callback of callbacks) {
            callback.apply(this, args);
        }
    };
}

// 可视化模式枚举
const VISUALIZATION_MODES = {
    WAVE: "wave",
    BARS: "bars",
    CIRCULAR: "circular"
};

/**
 * 音频可视化器类
 */
class AudioVisualizer {
    constructor(node) {
        this.node = node;
        this.canvas = null;
        this.ctx = null;
        this.audioContext = null;
        this.analyser = null;
        this.audioElement = null;
        this.source = null;
        this.animationFrameId = null;
        this.isInitialized = false;
        
        this.modeMenu = null;
        this.isOfficialNode = !this.node.widgets.find(w => w.name === "visualization_mode");
        if (!this.node.properties) {
            this.node.properties = {};
        }
        this.modeStorageKey = "__audio_visualizer_mode";
        this.opacityStorageKey = "__audio_visualizer_bg_opacity";
        this.backgroundImageKey = "__audio_visualizer_bg_image";
        this.enabledKey = "__audio_visualizer_enabled";
        
        // 默认配置
        this.config = {
            mode: this.isOfficialNode ? (this.node.properties[this.modeStorageKey] || VISUALIZATION_MODES.BARS) : VISUALIZATION_MODES.WAVE,
            fftSize: 2048,
            primaryColor: "#8b5cf6",
            secondaryColor: "#3b82f6",
            backgroundColor: "#09090b"
        };
        this.backgroundOpacity = this.isOfficialNode ? (this.node.properties[this.opacityStorageKey] ?? 0.2) : 0;
        this.backgroundImageData = this.isOfficialNode ? (this.node.properties[this.backgroundImageKey] || null) : null;
        this.backgroundImageCanvas = null;
        const savedEnabled = this.node.properties[this.enabledKey];
        // 默认开启可视化（官方和自定义节点都是），如果用户手动改过则以保存值为准
        this.visualizerEnabled = typeof savedEnabled === "boolean"
            ? savedEnabled
            : true;
        
        this.init();
        
        if (this.backgroundImageData) {
            this.setBackgroundImage(this.backgroundImageData).catch(err => console.error("AudioVisualizer: failed to load background image", err));
        }
    }
    
    /**
     * 初始化可视化器
     */
    init() {
        // 等待节点完全创建和布局完成
        // 使用多重检查确保节点和 widget 都已准备好
        const tryInit = (attempts = 0) => {
            if (attempts > 50) {
                console.warn("AudioVisualizer: Failed to initialize after multiple attempts");
                return;
            }
            
            // 检查节点是否已完全初始化
            if (!this.node || !this.node.widgets) {
                setTimeout(() => tryInit(attempts + 1), 50);
                return;
            }
            
            // 对于大多数节点会有 audio 输入 widget，但像 PreviewAudio 只有 audioUI 没有 audio
            const audioWidget = this.node.widgets.find(w => w.name === "audio");
            const audioUIWidget = this.node.widgets.find(w => w.name === "audioUI");

            // 如果既没有 audio 也没有 audioUI，说明节点还没完全构建，稍后重试
            if (!audioWidget && (!this.isOfficialNode || !audioUIWidget)) {
                setTimeout(() => tryInit(attempts + 1), 50);
                return;
            }
            
            // 节点已准备好，创建 Canvas widget
            try {
                this.createCanvasWidget();
                if (audioWidget) {
                    this.setupAudioWidget();
                }
                if (this.isOfficialNode) {
                    this.setupOfficialAudioUI();
                }
            } catch (e) {
                console.error("AudioVisualizer: Error during initialization:", e);
            }
        };
        
        // 立即尝试一次，如果失败则延迟重试
        if (this.node && this.node.widgets) {
            tryInit();
        } else {
            setTimeout(() => tryInit(), 100);
        }
    }
    
    /**
     * 创建 Canvas Widget
     */
    createCanvasWidget() {
        // 检查是否已存在
        if (this.node.widgets.find(w => w.name === "visualizer_canvas")) {
            return;
        }
        
        // 先创建 Canvas 元素
        const canvas = document.createElement("canvas");
        canvas.style.width = "100%";
        canvas.style.height = "200px";
        canvas.style.display = "block";
        canvas.style.backgroundColor = this.config.backgroundColor;
        canvas.style.borderRadius = "4px";
        canvas.width = 800;
        canvas.height = 200;
        
        let widgetElement = canvas;
        
        // 如果需要添加模式菜单（官方节点），使用容器包装
        if (this.isOfficialNode) {
            const container = document.createElement("div");
            container.style.position = "relative";
            container.style.width = "100%";
            container.style.height = "220px";
            
            container.appendChild(canvas);
            this.createModeMenu(container);
            widgetElement = container;
        }
        
        // 创建 Canvas widget（正确的用法：第三个参数是元素，第四个参数是选项）
        const canvasWidget = this.node.addDOMWidget("visualizer_canvas", "canvas", widgetElement, {
            serialize: false
        });
        
        // 保存引用
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        
        // 绘制初始提示
        if (this.ctx) {
            this.drawPlaceholder();
        }
        
        // 监听节点大小变化
        const originalOnResize = this.node.onResize;
        this.node.onResize = () => {
            if (originalOnResize) {
                originalOnResize.apply(this.node, arguments);
            }
            
            if (this.canvas) {
                // 使用 requestAnimationFrame 确保在布局更新后执行
                requestAnimationFrame(() => {
                    const targetElement = this.isOfficialNode ? this.canvas.parentElement : this.canvas;
                    if (this.canvas && targetElement) {
                        const rect = targetElement.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            this.canvas.width = Math.max(400, rect.width - (this.isOfficialNode ? 30 : 20));
                            this.canvas.height = Math.max(200, this.isOfficialNode ? rect.height - 30 : Math.min(300, rect.height * 0.3));
                        }
                    }
                });
            }
        };
    }
    
    /**
     * 设置音频 Widget 监听
     */
    setupAudioWidget() {
        // 等待 widget 完全初始化
        const trySetup = () => {
            // 查找音频 widget
            const audioWidget = this.node.widgets.find(w => w.name === "audio");
            if (!audioWidget) {
                // 如果还没创建，稍后重试
                setTimeout(trySetup, 100);
                return;
            }
            
            // 确保 audioWidget.options 存在
            if (!audioWidget.options) {
                audioWidget.options = {};
            }
            if (!audioWidget.options.values) {
                audioWidget.options.values = [];
            }
            
            // 监听音频文件变化
            const originalCallback = audioWidget.callback;
            audioWidget.callback = (value) => {
                if (originalCallback) originalCallback(value);
                this.handleAudioChange(value);
            };
            
            // 如果已有音频文件，立即处理
            if (audioWidget.value) {
                this.handleAudioChange(audioWidget.value);
            }
            
            // 监听可视化参数变化
            this.setupParameterWidgets();
        };
        
        trySetup();
    }
    
    /**
     * 设置参数 Widget 监听
     */
    setupParameterWidgets() {
        // 检查是否是自定义节点（有可视化参数）
        const isCustomNode = !this.isOfficialNode;
        
        if (!isCustomNode) {
            // 官方节点，使用默认配置，但要更新菜单显示
            this.updateModeMenu();
            return;
        }

        // 自定义节点，监听参数变化
        const modeWidget = this.node.widgets.find(w => w.name === "visualization_mode");
        const fftWidget = this.node.widgets.find(w => w.name === "fft_size");
        const primaryWidget = this.node.widgets.find(w => w.name === "primary_color");
        const secondaryWidget = this.node.widgets.find(w => w.name === "secondary_color");
        const bgWidget = this.node.widgets.find(w => w.name === "background_color");
        
        if (modeWidget) {
            modeWidget.callback = (value) => {
                this.setMode(value);
            };
        }
        
        if (fftWidget) {
            fftWidget.callback = (value) => {
                this.config.fftSize = parseInt(value);
                if (this.analyser) {
                    this.analyser.fftSize = this.config.fftSize;
                }
            };
        }
        
        if (primaryWidget) {
            primaryWidget.callback = (value) => {
                this.config.primaryColor = value || "#8b5cf6";
            };
        }
        
        if (secondaryWidget) {
            secondaryWidget.callback = (value) => {
                this.config.secondaryColor = value || "#3b82f6";
            };
        }
        
        if (bgWidget) {
            bgWidget.callback = (value) => {
                this.config.backgroundColor = value || "#09090b";
                if (this.canvas) {
                    this.canvas.style.backgroundColor = this.config.backgroundColor;
                }
            };
        }
        
        // 读取初始值
        if (modeWidget && modeWidget.value) this.setMode(modeWidget.value);
        if (fftWidget && fftWidget.value) this.config.fftSize = parseInt(fftWidget.value);
        if (primaryWidget && primaryWidget.value) this.config.primaryColor = primaryWidget.value;
        if (secondaryWidget && secondaryWidget.value) this.config.secondaryColor = secondaryWidget.value;
        if (bgWidget && bgWidget.value) this.config.backgroundColor = bgWidget.value;
    }
    
    /**
     * 创建模式菜单（仅官方节点）
     */
    createModeMenu(container) {
        const button = document.createElement("button");
        button.style.position = "absolute";
        button.style.top = "10px";
        button.style.right = "10px";
        button.style.padding = "2px 6px";
        button.style.border = "1px solid rgba(255,255,255,0.25)";
        button.style.borderRadius = "4px";
        button.style.background = "rgba(0,0,0,0.4)";
        button.style.color = "#fff";
        button.style.fontSize = "10px";
        button.style.cursor = "pointer";
        button.style.backdropFilter = "blur(6px)";
        button.style.display = "flex";
        button.style.alignItems = "center";
        button.style.gap = "4px";

        const icon = document.createElement("span");
        icon.textContent = "▦";
        icon.style.fontSize = "9px";
        icon.style.opacity = "0.8";

        const label = document.createElement("span");
        label.textContent = this.getModeLabel(this.config.mode);

        button.appendChild(icon);
        button.appendChild(label);

        const menu = document.createElement("div");
        menu.style.position = "absolute";
        menu.style.top = "36px";
        menu.style.right = "10px";
        menu.style.background = "rgba(15,15,20,0.95)";
        menu.style.border = "1px solid rgba(255,255,255,0.1)";
        menu.style.borderRadius = "8px";
        menu.style.padding = "6px 0";
        menu.style.minWidth = "150px";
        menu.style.boxShadow = "0 8px 24px rgba(0,0,0,0.4)";
        menu.style.backdropFilter = "blur(8px)";
        menu.style.display = "none";
        menu.style.zIndex = "10";

        // 可视化开关
        const enabledRow = document.createElement("div");
        enabledRow.style.display = "flex";
        enabledRow.style.alignItems = "center";
        enabledRow.style.justifyContent = "space-between";
        enabledRow.style.padding = "4px 12px 6px";
        enabledRow.style.fontSize = "11px";
        enabledRow.style.color = "#eee";

        const enabledLabel = document.createElement("span");
        enabledLabel.textContent = "Enable visualizer";

        const enabledCheckbox = document.createElement("input");
        enabledCheckbox.type = "checkbox";
        enabledCheckbox.checked = this.visualizerEnabled;

        enabledCheckbox.addEventListener("change", () => {
            this.setEnabled(enabledCheckbox.checked);
        });

        enabledRow.appendChild(enabledLabel);
        enabledRow.appendChild(enabledCheckbox);
        menu.appendChild(enabledRow);

        const modes = [
            { value: VISUALIZATION_MODES.WAVE, label: "Waveform" },
            { value: VISUALIZATION_MODES.BARS, label: "Spectral Bars" },
            { value: VISUALIZATION_MODES.CIRCULAR, label: "Circular" },
        ];

        modes.forEach(mode => {
            const item = document.createElement("div");
            item.textContent = mode.label;
            item.style.padding = "6px 12px";
            item.style.fontSize = "11px";
            item.style.cursor = "pointer";
            item.style.color = mode.value === this.config.mode ? "#8b5cf6" : "#fff";
            item.style.background = mode.value === this.config.mode ? "rgba(139,92,246,0.15)" : "transparent";

            item.addEventListener("mouseenter", () => {
                item.style.background = "rgba(255,255,255,0.1)";
            });
            item.addEventListener("mouseleave", () => {
                item.style.background = mode.value === this.config.mode ? "rgba(139,92,246,0.15)" : "transparent";
            });

            item.addEventListener("click", () => {
                this.setMode(mode.value);
                label.textContent = mode.label;
                menu.style.display = "none";
            });

            menu.appendChild(item);
        });

        // 背景控制分隔线
        const divider = document.createElement("div");
        divider.style.height = "1px";
        divider.style.margin = "4px 0";
        divider.style.background = "rgba(255,255,255,0.1)";
        menu.appendChild(divider);

        // 背景控制
        const bgLabel = document.createElement("div");
        bgLabel.textContent = "Background overlay";
        bgLabel.style.fontSize = "11px";
        bgLabel.style.color = "#bbb";
        bgLabel.style.padding = "4px 12px";
        menu.appendChild(bgLabel);

        const sliderWrapper = document.createElement("div");
        sliderWrapper.style.padding = "0 12px 6px";

        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "0";
        slider.max = "0.5";
        slider.step = "0.01";
        slider.value = this.backgroundOpacity;
        slider.style.width = "100%";

        slider.addEventListener("input", () => {
            this.setBackgroundOpacity(parseFloat(slider.value));
        });

        sliderWrapper.appendChild(slider);
        menu.appendChild(sliderWrapper);

        // 背景图片控制
        const bgWrapper = document.createElement("div");
        bgWrapper.style.padding = "0 12px 8px";
        bgWrapper.style.display = "flex";
        bgWrapper.style.flexDirection = "column";
        bgWrapper.style.gap = "4px";

        const preview = document.createElement("div");
        preview.style.height = "40px";
        preview.style.border = "1px solid rgba(255,255,255,0.1)";
        preview.style.borderRadius = "4px";
        preview.style.backgroundColor = "rgba(255,255,255,0.05)";
        preview.style.backgroundSize = "cover";
        preview.style.backgroundPosition = "center";
        this.applyPreviewBackground(preview);

        const buttonRow = document.createElement("div");
        buttonRow.style.display = "flex";
        buttonRow.style.gap = "6px";

        const uploadBtn = document.createElement("button");
        uploadBtn.textContent = "Upload image";
        uploadBtn.style.flex = "1";
        uploadBtn.style.fontSize = "10px";
        uploadBtn.style.padding = "4px 6px";
        uploadBtn.style.border = "1px solid rgba(255,255,255,0.15)";
        uploadBtn.style.borderRadius = "4px";
        uploadBtn.style.background = "rgba(255,255,255,0.06)";
        uploadBtn.style.color = "#fff";
        uploadBtn.style.cursor = "pointer";

        const clearBtn = document.createElement("button");
        clearBtn.textContent = "Clear";
        clearBtn.style.fontSize = "10px";
        clearBtn.style.padding = "4px 6px";
        clearBtn.style.border = "1px solid rgba(255,255,255,0.15)";
        clearBtn.style.borderRadius = "4px";
        clearBtn.style.background = "rgba(255,255,255,0.06)";
        clearBtn.style.color = "#fff";
        clearBtn.style.cursor = "pointer";

        buttonRow.appendChild(uploadBtn);
        buttonRow.appendChild(clearBtn);

        bgWrapper.appendChild(preview);
        bgWrapper.appendChild(buttonRow);
        menu.appendChild(bgWrapper);

        const hiddenInput = document.createElement("input");
        hiddenInput.type = "file";
        hiddenInput.accept = "image/*";
        hiddenInput.style.display = "none";
        container.appendChild(hiddenInput);

        uploadBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            hiddenInput.value = "";
            hiddenInput.click();
        });

        hiddenInput.addEventListener("change", async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            try {
                const dataUrl = await this.loadImageAsDataURL(file, 512);
                await this.setBackgroundImage(dataUrl);
                this.applyPreviewBackground(preview);
            } catch (err) {
                console.error("AudioVisualizer: failed to load background image", err);
            }
        });

        clearBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await this.setBackgroundImage(null);
            this.applyPreviewBackground(preview);
        });

        button.addEventListener("click", (e) => {
            e.stopPropagation();
            menu.style.display = menu.style.display === "none" ? "block" : "none";
        });

        document.addEventListener("click", () => {
            menu.style.display = "none";
        });

        container.appendChild(button);
        container.appendChild(menu);

        this.modeMenu = { button, label, menu, modes, slider, preview, enabledCheckbox };
    }

    /**
     * 更新模式菜单显示
     */
    updateModeMenu() {
        if (!this.modeMenu) return;
        const { label, menu, modes, enabledCheckbox } = this.modeMenu;
        if (label) {
            label.textContent = this.getModeLabel(this.config.mode);
        }
        if (menu && modes) {
            // first modes.length children are mode items
            modes.forEach((mode, index) => {
                const item = menu.children[index];
                if (!item) return;
                item.style.color = mode.value === this.config.mode ? "#8b5cf6" : "#fff";
                item.style.background = mode.value === this.config.mode ? "rgba(139,92,246,0.15)" : "transparent";
            });
        }
        if (this.modeMenu?.slider) {
            this.modeMenu.slider.value = this.backgroundOpacity;
        }
        if (this.modeMenu?.preview) {
            this.applyPreviewBackground(this.modeMenu.preview);
        }
        if (enabledCheckbox) {
            enabledCheckbox.checked = this.visualizerEnabled;
        }
    }

    /**
     * 根据模式值获取标签
     */
    getModeLabel(mode) {
        switch (mode) {
            case VISUALIZATION_MODES.WAVE:
                return "Waveform";
            case VISUALIZATION_MODES.BARS:
                return "Spectral Bars";
            case VISUALIZATION_MODES.CIRCULAR:
                return "Circular";
            default:
                return "Visualizer";
        }
    }

    /**
     * 设置模式（官方节点和自定义节点共用）
     */
    setMode(mode) {
        if (this.config.mode === mode) return;
        this.config.mode = mode;
        if (this.isOfficialNode) {
            this.node.properties[this.modeStorageKey] = mode;
            this.updateModeMenu();
        }
        if (this.isInitialized) {
            this.startVisualization();
        }
    }

    /**
     * 开关可视化（主要用于官方节点）
     */
    setEnabled(enabled) {
        this.visualizerEnabled = !!enabled;
        if (this.isOfficialNode) {
            this.node.properties[this.enabledKey] = this.visualizerEnabled;
        }
        this.updateModeMenu();

        if (!this.visualizerEnabled) {
            // 关闭可视化，但不影响音频播放
            this.cleanup();
        } else if (this.isOfficialNode) {
            // 如果当前已经有 audioUI 并在播放，尝试立即连接
            const audioUIWidget = this.node.widgets?.find(w => w.name === "audioUI");
            if (audioUIWidget && audioUIWidget.element && audioUIWidget.element.tagName === "AUDIO") {
                const audioElement = audioUIWidget.element;
                if (!audioElement.paused) {
                    this.connectToAudioElement(audioElement);
                }
            }
        }
    }

    /**
     * 设置背景透明度
     */
    setBackgroundOpacity(value) {
        this.backgroundOpacity = Math.max(0, Math.min(0.5, value || 0));
        if (this.isOfficialNode) {
            this.node.properties[this.opacityStorageKey] = this.backgroundOpacity;
        }
        this.updateModeMenu();
    }

    /**
     * 获取背景图案
     */
    getBackgroundPattern() {
        return "radial-gradient(circle at 30% 30%, rgba(139,92,246,0.35), transparent 45%)," +
               "radial-gradient(circle at 70% 60%, rgba(59,130,246,0.25), transparent 55%)," +
               "linear-gradient(120deg, rgba(255,255,255,0.08) 0%, transparent 40%)," +
               "linear-gradient(300deg, rgba(255,255,255,0.04) 0%, transparent 45%)";
    }

    /**
     * 绘制背景图层
     */
    renderBackground(WIDTH, HEIGHT) {
        this.ctx.fillStyle = this.config.backgroundColor;
        this.ctx.fillRect(0, 0, WIDTH, HEIGHT);

        if (this.backgroundImageCanvas) {
            this.ctx.save();
            this.ctx.globalAlpha = Math.max(0, Math.min(1, this.backgroundOpacity + 0.05));
            this.ctx.drawImage(this.backgroundImageCanvas, 0, 0, WIDTH, HEIGHT);
            this.ctx.restore();
        } else if (this.backgroundOpacity > 0) {
            this.ctx.save();
            this.ctx.globalAlpha = this.backgroundOpacity;

            const radial = this.ctx.createRadialGradient(WIDTH * 0.3, HEIGHT * 0.3, 0, WIDTH * 0.3, HEIGHT * 0.3, Math.max(WIDTH, HEIGHT));
            radial.addColorStop(0, this.hexToRgba(this.config.primaryColor, 0.35));
            radial.addColorStop(1, "transparent");
            this.ctx.fillStyle = radial;
            this.ctx.fillRect(0, 0, WIDTH, HEIGHT);

            const gradient = this.ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
            gradient.addColorStop(0, this.hexToRgba(this.config.secondaryColor, 0.15));
            gradient.addColorStop(1, "transparent");
            this.ctx.fillStyle = gradient;
            this.ctx.fillRect(0, 0, WIDTH, HEIGHT);

            this.ctx.restore();
        }
    }

    /**
     * 应用预览背景显示
     */
    applyPreviewBackground(preview) {
        if (!preview) return;
        if (this.backgroundImageData) {
            preview.style.backgroundImage = `url(${this.backgroundImageData})`;
            preview.style.backgroundColor = "transparent";
        } else {
            preview.style.backgroundImage = "none";
            preview.style.backgroundColor = "rgba(255,255,255,0.05)";
        }
    }

    /**
     * 读取文件为 DataURL 并自动缩放
     */
    async loadImageAsDataURL(file, maxSize = 512) {
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        const canvas = await this.createImageCanvasFromDataUrl(dataUrl, maxSize);
        return canvas.toDataURL("image/png");
    }

    /**
     * 根据 DataURL 创建缩放后的 Canvas
     */
    async createImageCanvasFromDataUrl(dataUrl, maxSize = 512) {
        const img = new Image();
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = dataUrl;
        });
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas;
    }

    /**
     * 设置背景图片
     */
    async setBackgroundImage(dataUrl, preScaledCanvas = null) {
        if (!dataUrl) {
            this.backgroundImageData = null;
            this.backgroundImageCanvas = null;
            if (this.isOfficialNode) {
                delete this.node.properties[this.backgroundImageKey];
            }
            this.updateModeMenu();
            return;
        }

        let canvas = preScaledCanvas;
        if (!canvas) {
            canvas = await this.createImageCanvasFromDataUrl(dataUrl, 512);
        }

        this.backgroundImageCanvas = canvas;
        const scaledDataUrl = canvas.toDataURL("image/png");
        this.backgroundImageData = scaledDataUrl;
        if (this.isOfficialNode) {
            this.node.properties[this.backgroundImageKey] = scaledDataUrl;
        }

        this.updateModeMenu();
    }

    /**
     * 针对官方 LoadAudio 节点，监听其 audioUI 播放事件以安全接入可视化
     */
    setupOfficialAudioUI() {
        if (!this.isOfficialNode) return;

        const trySetup = (attempts = 0) => {
            if (attempts > 50) return;
            const audioUIWidget = this.node.widgets?.find(w => w.name === "audioUI");
            if (!audioUIWidget || !audioUIWidget.element || audioUIWidget.element.tagName !== "AUDIO") {
                setTimeout(() => trySetup(attempts + 1), 100);
                return;
            }

            const audioElement = audioUIWidget.element;

            const onPlay = () => {
                if (!this.visualizerEnabled) return;
                this.connectToAudioElement(audioElement);
            };

            const onStop = () => {
                if (!this.visualizerEnabled) return;
                this.stopVisualization();
            };

            audioElement.addEventListener("play", onPlay);
            audioElement.addEventListener("pause", onStop);
            audioElement.addEventListener("ended", onStop);
        };

        trySetup();
    }
    
    /**
     * 处理音频文件变化
     */
    handleAudioChange(audioValue) {
        if (!audioValue) {
            this.cleanup();
            this.drawPlaceholder();
            return;
        }
        
        // 优先使用 audioUI widget 的 audio 元素
        const audioUIWidget = this.node.widgets?.find(w => w.name === "audioUI");
        if (audioUIWidget && audioUIWidget.element && audioUIWidget.element.tagName === "AUDIO") {
            const audioElement = audioUIWidget.element;
            // 等待音频源更新
            const checkSrc = () => {
                if (audioElement.src) {
                    this.connectToAudioElement(audioElement);
                } else {
                    setTimeout(checkSrc, 100);
                }
            };
            checkSrc();
            return;
        }
        
        // 如果没有 audioUI widget，使用 URL 加载
        const audioUrl = this.getAudioUrl(audioValue);
        if (!audioUrl) {
            this.drawPlaceholder("无法加载音频文件");
            return;
        }
        
        this.loadAudio(audioUrl);
    }
    
    /**
     * 获取音频 URL
     */
    getAudioUrl(audioValue) {
        try {
            // 解析文件路径（格式可能是 "filename" 或 "subfolder/filename"）
            const folderSeparator = audioValue.lastIndexOf("/");
            let filename, subfolder;
            
            if (folderSeparator === -1) {
                // 没有子文件夹
                filename = audioValue;
                subfolder = "";
            } else {
                // 有子文件夹
                subfolder = audioValue.substring(0, folderSeparator);
                filename = audioValue.substring(folderSeparator + 1);
            }
            
            const type = "input";
            
            // 构建 URL 参数
            const params = [
                "filename=" + encodeURIComponent(filename),
                "type=" + type,
                "subfolder=" + encodeURIComponent(subfolder),
                (app.getRandParam ? app.getRandParam().substring(1) : "t=" + Date.now())
            ].join("&");
            
            const resourceUrl = `/view?${params}`;
            
            // 使用 ComfyUI API 获取完整 URL
            if (app.api && app.api.apiURL) {
                return app.api.apiURL(resourceUrl);
            }
            
            // 备用方案：直接返回相对 URL
            return resourceUrl;
        } catch (e) {
            console.error("Error getting audio URL:", e);
            return null;
        }
    }
    
    /**
     * 连接到现有的 audio 元素（来自 audioUI widget）
     */
    connectToAudioElement(audioElement) {
        if (!this.visualizerEnabled) {
            return;
        }
        if (!audioElement) {
            return;
        }
        
        // 如果已经是同一个元素且已初始化，不需要重新连接
        if (audioElement === this.audioElement && this.isInitialized) {
            // 如果已初始化但未开始，重新开始
            if (!this.animationFrameId) {
                this.startVisualization();
            }
            return;
        }
        
        // 清理旧的连接
        if (this.audioElement !== audioElement) {
            this.cleanup();
        }
        
        this.audioElement = audioElement;
        
        // 初始化 AudioContext
        const initContext = () => {
            try {
                // 如果 AudioContext 已存在且未关闭，先关闭
                if (this.audioContext && this.audioContext.state !== "closed") {
                    this.audioContext.close().catch(() => {});
                }
                
                // 创建 AudioContext
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                this.audioContext = new AudioContextClass();
                
                // 如果 AudioContext 被暂停（浏览器策略），恢复它
                if (this.audioContext.state === "suspended") {
                    this.audioContext.resume();
                }
                
                // 创建 AnalyserNode
                this.analyser = this.audioContext.createAnalyser();
                this.analyser.fftSize = this.config.fftSize;
                this.analyser.smoothingTimeConstant = 0.85;
                
                // 创建音频源（注意：一个 audio 元素只能创建一个 MediaElementSource）
                // 当创建 MediaElementSource 后，audio 元素的音频输出会被重定向到 AudioContext
                // 所以我们必须确保音频通过我们的 AudioContext 输出到 destination
                try {
                    // 检查是否已经为这个 audio 元素创建过 source
                    if (!audioElement._audioVisualizerSource) {
                        // 创建 MediaElementSource（这会"劫持"audio 元素的音频输出）
                        this.source = this.audioContext.createMediaElementSource(audioElement);
                        audioElement._audioVisualizerSource = this.source;
                        
                        // 连接音频流：source -> analyser -> destination
                        // 这样音频既能被分析（用于可视化），又能输出到扬声器
                        this.source.connect(this.analyser);
                        this.analyser.connect(this.audioContext.destination);
                    } else {
                        // 如果已经创建过 source，我们需要重新连接它
                        console.warn("MediaElementSource already exists, reusing it");
                        this.source = audioElement._audioVisualizerSource;
                        
                        // 断开所有现有连接
                        try {
                            this.source.disconnect();
                        } catch (e) {
                            // 忽略断开连接的错误
                        }
                        
                        // 重新连接到我们的分析链
                        this.source.connect(this.analyser);
                        this.analyser.connect(this.audioContext.destination);
                    }
                    
                    // 确保 AudioContext 处于运行状态（浏览器策略要求用户交互）
                    if (this.audioContext.state === "suspended") {
                        this.audioContext.resume().then(() => {
                            console.log("AudioContext resumed");
                        }).catch((e) => {
                            console.error("Failed to resume AudioContext:", e);
                        });
                    }
                } catch (e) {
                    console.error("Error creating MediaElementSource:", e);
                    // 如果创建失败，可能是已经创建过了
                    // 尝试使用现有的 source
                    if (audioElement._audioVisualizerSource) {
                        try {
                            this.source = audioElement._audioVisualizerSource;
                            this.source.disconnect();
                            this.source.connect(this.analyser);
                            this.analyser.connect(this.audioContext.destination);
                        } catch (e2) {
                            console.error("Failed to reuse existing source:", e2);
                            this.drawPlaceholder("无法连接到音频源");
                            return;
                        }
                    } else {
                        this.drawPlaceholder("无法连接到音频源: " + e.message);
                        return;
                    }
                }
                
                this.isInitialized = true;
                
                // 如果音频正在播放，立即开始可视化
                if (!audioElement.paused) {
                    this.startVisualization();
                }
            } catch (e) {
                console.error("Error initializing AudioContext:", e);
                this.drawPlaceholder("浏览器不支持音频分析: " + e.message);
            }
        };
        
        // 如果音频已加载，立即初始化
        if (audioElement.readyState >= 2) {
            initContext();
        } else {
            // 等待音频加载
            const onLoadedData = () => {
                initContext();
            };
            audioElement.addEventListener("loadeddata", onLoadedData, { once: true });
            
            // 如果音频已经在播放，也尝试初始化（可能 readyState 还没更新）
            if (!audioElement.paused) {
                setTimeout(() => {
                    if (!this.isInitialized && audioElement.readyState >= 1) {
                        initContext();
                    }
                }, 100);
            }
        }
    }
    
    /**
     * 加载音频并初始化可视化
     */
    loadAudio(audioUrl) {
        // 仅自定义节点会主动加载独立的 Audio 元素
        if (this.isOfficialNode) {
            return;
        }
        this.cleanup();
        
        // 先检查是否有 audioUI widget 的 audio 元素
        const audioUIWidget = this.node.widgets?.find(w => w.name === "audioUI");
        if (audioUIWidget && audioUIWidget.element && audioUIWidget.element.tagName === "AUDIO") {
            // 使用现有的 audio 元素
            this.connectToAudioElement(audioUIWidget.element);
            return;
        }
        
        // 如果没有，创建新的音频元素
        const audio = new Audio(audioUrl);
        audio.crossOrigin = "anonymous";
        
        audio.onloadeddata = () => {
            this.initAudioContext(audio);
        };
        
        audio.onerror = (e) => {
            console.error("Audio load error:", e);
            this.drawPlaceholder("音频加载失败");
        };
        
        this.audioElement = audio;
    }
    
    /**
     * 初始化 AudioContext
     */
    initAudioContext(audioElement) {
        // 使用 connectToAudioElement 方法，它已经包含了完整的初始化逻辑
        this.connectToAudioElement(audioElement);
    }
    
    /**
     * 开始可视化
     */
    startVisualization() {
        if (!this.isInitialized || !this.analyser || !this.ctx) {
            return;
        }
        
        this.stopVisualization();
        this.draw();
    }
    
    /**
     * 停止可视化
     */
    stopVisualization() {
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
    }
    
    /**
     * 绘制函数
     */
    draw() {
        if (!this.ctx || !this.analyser || !this.canvas) {
            return;
        }
        
        // 处理画布大小变化
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            if (this.canvas.width !== rect.width || this.canvas.height !== rect.height) {
                this.canvas.width = rect.width;
                this.canvas.height = Math.max(200, rect.height);
            }
        }
        
        const WIDTH = this.canvas.width;
        const HEIGHT = this.canvas.height;
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        // 绘制背景
        this.renderBackground(WIDTH, HEIGHT);
        
        // 根据模式绘制
        if (this.config.mode === VISUALIZATION_MODES.WAVE) {
            this.drawWave(dataArray, WIDTH, HEIGHT, bufferLength);
        } else if (this.config.mode === VISUALIZATION_MODES.BARS) {
            this.drawBars(dataArray, WIDTH, HEIGHT, bufferLength);
        } else if (this.config.mode === VISUALIZATION_MODES.CIRCULAR) {
            this.drawCircular(dataArray, WIDTH, HEIGHT, bufferLength);
        }
        
        this.animationFrameId = requestAnimationFrame(() => this.draw());
    }
    
    /**
     * 绘制波形图
     */
    drawWave(dataArray, WIDTH, HEIGHT, bufferLength) {
        this.analyser.getByteTimeDomainData(dataArray);
        
        // 绘制主波形
        this.ctx.lineWidth = 2;
        this.ctx.strokeStyle = this.config.primaryColor;
        this.ctx.beginPath();
        
        const sliceWidth = WIDTH / bufferLength;
        let x = 0;
        
        for (let i = 0; i < bufferLength; i++) {
            const v = dataArray[i] / 128.0;
            const y = (v * HEIGHT) / 2;
            
            if (i === 0) {
                this.ctx.moveTo(x, y);
            } else {
                this.ctx.lineTo(x, y);
            }
            
            x += sliceWidth;
        }
        
        this.ctx.lineTo(WIDTH, HEIGHT / 2);
        this.ctx.stroke();
        
        // 绘制辅助波形
        this.ctx.lineWidth = 1;
        this.ctx.strokeStyle = this.config.secondaryColor;
        this.ctx.beginPath();
        x = 0;
        for (let i = 0; i < bufferLength; i += 5) {
            const v = dataArray[i] / 128.0;
            const y = (v * HEIGHT) / 2 + 5;
            if (i === 0) {
                this.ctx.moveTo(x, y);
            } else {
                this.ctx.lineTo(x, y);
            }
            x += sliceWidth * 5;
        }
        this.ctx.stroke();
    }
    
    /**
     * 绘制频谱柱状图
     */
    drawBars(dataArray, WIDTH, HEIGHT, bufferLength) {
        this.analyser.getByteFrequencyData(dataArray);
        
        const barWidth = (WIDTH / bufferLength) * 2.5;
        let x = 0;
        
        for (let i = 0; i < bufferLength; i++) {
            const barHeight = (dataArray[i] / 255) * HEIGHT;
            
            // 创建渐变
            const gradient = this.ctx.createLinearGradient(0, HEIGHT, 0, HEIGHT - barHeight);
            gradient.addColorStop(0, this.config.secondaryColor);
            gradient.addColorStop(1, this.config.primaryColor);
            
            this.ctx.fillStyle = gradient;
            this.ctx.fillRect(x, HEIGHT - barHeight, barWidth, barHeight);
            
            x += barWidth + 1;
            if (x > WIDTH) break;
        }
    }
    
    /**
     * 绘制圆形频谱图
     */
    drawCircular(dataArray, WIDTH, HEIGHT, bufferLength) {
        this.analyser.getByteFrequencyData(dataArray);
        
        const centerX = WIDTH / 2;
        const centerY = HEIGHT / 2;
        const radius = Math.min(WIDTH, HEIGHT) / 4;
        
        // 绘制中心圆
        this.ctx.beginPath();
        this.ctx.arc(centerX, centerY, radius - 10, 0, 2 * Math.PI);
        this.ctx.fillStyle = this.hexToRgba(this.config.secondaryColor, 0.2);
        this.ctx.fill();
        
        // 绘制径向柱状图
        const barsToDraw = 180;
        const step = Math.floor(bufferLength / barsToDraw);
        const angleStep = (2 * Math.PI) / barsToDraw;
        
        for (let i = 0; i < barsToDraw; i++) {
            const value = dataArray[i * step];
            const barHeight = (value / 255) * (Math.min(WIDTH, HEIGHT) / 3);
            const angle = i * angleStep;
            
            // 外圈柱状图
            const x1 = centerX + Math.cos(angle) * radius;
            const y1 = centerY + Math.sin(angle) * radius;
            const x2 = centerX + Math.cos(angle) * (radius + barHeight);
            const y2 = centerY + Math.sin(angle) * (radius + barHeight);
            
            this.ctx.strokeStyle = this.config.primaryColor;
            this.ctx.lineWidth = 2;
            this.ctx.beginPath();
            this.ctx.moveTo(x1, y1);
            this.ctx.lineTo(x2, y2);
            this.ctx.stroke();
            
            // 内圈反射
            const x3 = centerX + Math.cos(angle) * (radius - barHeight * 0.3);
            const y3 = centerY + Math.sin(angle) * (radius - barHeight * 0.3);
            this.ctx.strokeStyle = this.config.secondaryColor;
            this.ctx.beginPath();
            this.ctx.moveTo(x1, y1);
            this.ctx.lineTo(x3, y3);
            this.ctx.stroke();
        }
    }
    
    /**
     * 绘制占位符
     */
    drawPlaceholder(text = "请加载音频文件") {
        if (!this.ctx || !this.canvas) return;
        
        const WIDTH = this.canvas.width;
        const HEIGHT = this.canvas.height;
        
        this.renderBackground(WIDTH, HEIGHT);
        
        // 绘制提示文字
        this.ctx.fillStyle = "#666";
        this.ctx.font = "14px Arial";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText(text, WIDTH / 2, HEIGHT / 2);
    }
    
    /**
     * 十六进制颜色转 RGBA
     */
    hexToRgba(hex, alpha = 1) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    
    /**
     * 清理资源
     */
    cleanup() {
        this.stopVisualization();
        
        if (this.source) {
            try {
                this.source.disconnect();
            } catch (e) {}
            this.source = null;
        }

        if (this.audioContext && this.audioContext.state !== "closed") {
            this.audioContext.close().catch(() => {});
            this.audioContext = null;
        }
        
        this.analyser = null;
        this.isInitialized = false;

        // 对于官方节点，不要干预其 audioUI 元素（播放由 ComfyUI 自己管理）
        // 只清理引用，避免内存泄露
        if (this.isOfficialNode) {
            this.audioElement = null;
        } else if (this.audioElement) {
            // 自定义节点使用内部创建的 Audio 对象，这里才需要暂停并清空
            try {
                this.audioElement.pause();
            } catch (e) {}
            this.audioElement.src = "";
            this.audioElement = null;
        }
    }
    
    /**
     * 销毁
     */
    destroy() {
        this.cleanup();
    }
}

// 注册扩展
app.registerExtension({
    name: "ComfyUI.AudioVisualizer",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        // 支持官方音频相关节点
        const isAudioNode =
            nodeData.name === "LoadAudio" ||
            nodeData.name === "SaveAudio" ||
            nodeData.name === "SaveAudioMP3" ||
            nodeData.name === "SaveAudioOpus" ||
            nodeData.name === "PreviewAudio";
        
        if (isAudioNode) {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            const onRemoved = nodeType.prototype.onRemoved;
            
            // 在节点创建之前就初始化 audio widget
            // 拦截 widget 的创建过程，确保 audio widget 的 options 在 AUDIOUPLOAD widget 创建之前就初始化
            const originalAddWidget = nodeType.prototype.addWidget;
            if (originalAddWidget) {
                nodeType.prototype.addWidget = function(...args) {
                    const widget = originalAddWidget.apply(this, args);
                    
                    // 如果是 audio widget，立即初始化 options
                    if (widget && widget.name === "audio") {
                        if (!widget.options) {
                            widget.options = {};
                        }
                        if (!widget.options.values) {
                            widget.options.values = [];
                        }
                    }
                    
                    return widget;
                };
            }
            
            nodeType.prototype.onNodeCreated = function() {
                if (onNodeCreated) {
                    onNodeCreated.apply(this, arguments);
                }
                
                // 再次确保 audio widget 的 options 存在
                const audioWidget = this.widgets?.find(w => w.name === "audio");
                if (audioWidget) {
                    if (!audioWidget.options) {
                        audioWidget.options = {};
                    }
                    if (!audioWidget.options.values) {
                        audioWidget.options.values = [];
                    }
                }
                
                // 初始化可视化器
                // 对于官方 LoadAudio 节点，使用默认配置
                // 对于自定义节点，会在 AudioVisualizer 中读取节点参数
                if (!this.audioVisualizer) {
                    this.audioVisualizer = new AudioVisualizer(this);
                }
            };
            
            nodeType.prototype.onRemoved = function() {
                if (this.audioVisualizer) {
                    this.audioVisualizer.destroy();
                    this.audioVisualizer = null;
                }
                
                if (onRemoved) {
                    onRemoved.apply(this, arguments);
                }
            };
        }
    },
    
    // 提供自定义 widget（目前不覆写任何官方 widget，完全使用官方 UI）
    // 我们只通过 AudioVisualizer 监听已有的 audio/audioUI 控件
    getCustomWidgets(app) {
        return {};
    }
});

