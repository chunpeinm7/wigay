// Wi-Care v2.0 前端應用程式

const API_BASE = window.location.origin;
const WS_URL = `ws://${window.location.host}`;
const AUTH = btoa('admin:admin123');

let ws = null;
let eventSource = null;
let entities = [];
let automations = [];
let scenes = [];
let groups = [];
let scripts = [];
let helpers = [];
let areas = [];
let notifications = [];

// ==================== 初始化 ====================

document.addEventListener('DOMContentLoaded', async () => {
    initWebSocket();
    initSSE();
    await loadAllData();
    addLog('系統初始化完成');
});

// ==================== 連接管理 ====================

function initWebSocket() {
    ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
        updateConnectionStatus('ws', true);
        addLog('WebSocket 連接成功');
    };
    
    ws.onclose = () => {
        updateConnectionStatus('ws', false);
        addLog('WebSocket 已斷開，3秒後重連...');
        setTimeout(initWebSocket, 3000);
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket 錯誤:', error);
    };
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleWebSocketMessage(data);
    };
}

function initSSE() {
    eventSource = new EventSource(`${API_BASE}/api/events`);
    
    eventSource.onopen = () => {
        updateConnectionStatus('sse', true);
        addLog('SSE 連接成功');
    };
    
    eventSource.onerror = () => {
        updateConnectionStatus('sse', false);
    };
    
    eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'status') {
            updateEntityCounts(data.entities);
        }
    };
}

function handleWebSocketMessage(data) {
    switch (data.type) {
        case 'state_changed':
            updateEntityInList(data.entity_id);
            addLog(`${data.entity_id} 狀態變更: ${data.old_state} → ${data.new_state}`);
            break;
        case 'notification':
            showNotification(data.title, data.message);
            break;
        case 'scene_activated':
            addLog(`場景 "${data.scene_name}" 已激活`);
            break;
        case 'automation_triggered':
            addLog(`自動化 "${data.name}" 已觸發`);
            break;
    }
}

function updateConnectionStatus(type, connected) {
    const dot = document.getElementById(`${type}Status`);
    const text = document.getElementById(`${type}StatusText`);
    
    if (connected) {
        dot.className = 'status-dot connected';
        text.textContent = '已連接';
    } else {
        dot.className = 'status-dot disconnected';
        text.textContent = '已斷開';
    }
}

// ==================== 數據載入 ====================

async function loadAllData() {
    await Promise.all([
        loadEntities(),
        loadAutomations(),
        loadScenes(),
        loadGroups(),
        loadScripts(),
        loadHelpers(),
        loadAreas(),
        loadNotifications(),
        loadSystemInfo()
    ]);
}

async function loadEntities() {
    try {
        const response = await fetch(`${API_BASE}/api/entities`);
        entities = await response.json();
        
        renderSwitches();
        renderSensors();
        renderAllEntities();
        updateEntityCounts(entities);
        updateHistoryEntitySelect();
        updateStatCards();
    } catch (error) {
        console.error('載入實體失敗:', error);
        addLog('載入實體失敗: ' + error.message, 'error');
    }
}

async function loadAutomations() {
    try {
        const response = await fetch(`${API_BASE}/api/automations`);
        automations = await response.json();
        
        renderAutomations();
        document.getElementById('automationCount').textContent = automations.length;
        updateStatCards();
    } catch (error) {
        console.error('載入自動化失敗:', error);
    }
}

async function loadScenes() {
    try {
        const response = await fetch(`${API_BASE}/api/scenes`);
        scenes = await response.json();
        
        renderScenes();
        renderQuickScenes();
        document.getElementById('sceneCount').textContent = scenes.length;
        updateStatCards();
    } catch (error) {
        console.error('載入場景失敗:', error);
    }
}

async function loadSystemInfo() {
    try {
        const response = await fetch(`${API_BASE}/api/system`);
        const data = await response.json();
        renderSystemInfo(data);
    } catch (error) {
        console.error('載入系統資訊失敗:', error);
    }
}

async function loadHistory() {
    const select = document.getElementById('historyEntity');
    const entityId = select.value;
    
    if (!entityId) return;
    
    try {
        const response = await fetch(`${API_BASE}/api/history?entity_id=${entityId}`);
        const data = await response.json();
        renderHistory(data, entityId);
    } catch (error) {
        console.error('載入歷史失敗:', error);
    }
}

// ==================== 渲染函數 ====================

function renderSwitches() {
    const container = document.getElementById('switchList');
    const switches = entities.filter(e => e.entity_id.startsWith('switch.'));
    
    if (switches.length === 0) {
        container.innerHTML = '<div class="empty-state">沒有開關設備</div>';
        return;
    }
    
    container.innerHTML = switches.map(entity => `
        <div class="entity-item" id="entity-${entity.entity_id}">
            <div class="entity-info">
                <div class="entity-name">${entity.attributes?.friendly_name || entity.entity_id}</div>
                <div class="entity-id">${entity.entity_id}</div>
            </div>
            <div class="entity-state">
                <span class="state-badge ${entity.state === 'on' ? 'state-on' : 'state-off'}">
                    ${entity.state === 'on' ? 'ON' : 'OFF'}
                </span>
                <div class="toggle-switch ${entity.state === 'on' ? 'active' : ''}" 
                     onclick="toggleEntity('${entity.entity_id}')"></div>
            </div>
        </div>
    `).join('');
}

function renderSensors() {
    const container = document.getElementById('sensorList');
    const sensors = entities.filter(e => e.entity_id.startsWith('sensor.'));
    
    if (sensors.length === 0) {
        container.innerHTML = '<div class="empty-state">沒有感測器</div>';
        return;
    }
    
    container.innerHTML = sensors.map(entity => `
        <div class="entity-item">
            <div class="entity-info">
                <div class="entity-name">${entity.attributes?.friendly_name || entity.entity_id}</div>
                <div class="entity-id">${entity.entity_id}</div>
            </div>
            <div class="entity-state">
                <span class="state-badge state-on">
                    ${entity.state} ${entity.attributes?.unit_of_measurement || ''}
                </span>
            </div>
        </div>
    `).join('');
}

function renderAllEntities() {
    const container = document.getElementById('allEntities');
    
    if (entities.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔌</div><div>尚未註冊任何實體</div></div>';
        return;
    }
    
    container.innerHTML = entities.map(entity => `
        <div class="entity-item">
            <div class="entity-info">
                <div class="entity-name">${entity.attributes?.friendly_name || entity.entity_id}</div>
                <div class="entity-id">${entity.entity_id}</div>
                <div style="font-size: 0.85em; color: var(--text-secondary); margin-top: 5px;">
                    狀態: ${entity.state} | 更新: ${new Date(entity.last_updated).toLocaleString('zh-TW')}
                </div>
            </div>
            <div class="entity-state">
                ${entity.entity_id.startsWith('switch.') || entity.entity_id.startsWith('light.') ? 
                    `<button class="btn btn-small" onclick="toggleEntity('${entity.entity_id}')">切換</button>` : ''}
                <button class="btn btn-small btn-danger" onclick="deleteEntity('${entity.entity_id}')">刪除</button>
            </div>
        </div>
    `).join('');
}

function renderAutomations() {
    const container = document.getElementById('automationList');
    
    if (automations.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🤖</div><div>尚未創建任何自動化規則<br>點擊上方按鈕創建第一個自動化</div></div>';
        return;
    }
    
    container.innerHTML = automations.map(auto => `
        <div class="automation-item">
            <div class="item-header">
                <div class="item-title">${auto.name}</div>
                <div class="toggle-switch ${auto.enabled ? 'active' : ''}" 
                     onclick="toggleAutomation('${auto.id}')"></div>
            </div>
            ${auto.description ? `<div class="item-description">${auto.description}</div>` : ''}
            <div style="font-size: 0.85em; color: var(--text-secondary); margin-bottom: 10px;">
                觸發器: ${auto.triggers?.length || 0} | 
                條件: ${auto.conditions?.length || 0} | 
                動作: ${auto.actions?.length || 0}
                ${auto.last_triggered ? `<br>最後觸發: ${new Date(auto.last_triggered).toLocaleString('zh-TW')}` : ''}
            </div>
            <div class="item-actions">
                <button class="btn btn-small btn-danger" onclick="deleteAutomation('${auto.id}')">刪除</button>
            </div>
        </div>
    `).join('');
}

function renderScenes() {
    const container = document.getElementById('sceneList');
    
    if (scenes.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🎬</div><div>尚未創建任何場景<br>點擊上方按鈕創建第一個場景</div></div>';
        return;
    }
    
    container.innerHTML = scenes.map(scene => `
        <div class="scene-item">
            <div class="item-header">
                <div class="item-title">${scene.icon || '🎬'} ${scene.name}</div>
            </div>
            ${scene.description ? `<div class="item-description">${scene.description}</div>` : ''}
            <div style="font-size: 0.85em; color: var(--text-secondary); margin-bottom: 10px;">
                包含 ${scene.entities?.length || 0} 個實體設定
            </div>
            <div class="item-actions">
                <button class="btn btn-small btn-success" onclick="activateScene('${scene.id}')">激活場景</button>
                <button class="btn btn-small btn-danger" onclick="deleteScene('${scene.id}')">刪除</button>
            </div>
        </div>
    `).join('');
}

function renderQuickScenes() {
    const container = document.getElementById('quickScenes');
    
    if (scenes.length === 0) {
        container.innerHTML = '<div class="empty-state">尚未創建場景</div>';
        return;
    }
    
    container.innerHTML = scenes.slice(0, 4).map(scene => `
        <div class="entity-item" onclick="activateScene('${scene.id}')" style="cursor: pointer;">
            <div class="entity-info">
                <div class="entity-name">${scene.icon || '🎬'} ${scene.name}</div>
                <div class="entity-id">${scene.entities?.length || 0} 個實體</div>
            </div>
            <button class="btn btn-small">激活</button>
        </div>
    `).join('');
}

function renderHistory(data, entityId) {
    const container = document.getElementById('historyData');
    
    if (data.length === 0) {
        container.innerHTML = '<div class="empty-state">沒有歷史數據</div>';
        return;
    }
    
    // 簡單的文字列表
    const html = `
        <div style="margin-top: 20px;">
            <h3>最近 ${Math.min(data.length, 50)} 筆記錄</h3>
            <div style="max-height: 400px; overflow-y: auto; margin-top: 15px;">
                ${data.slice(-50).reverse().map(record => `
                    <div style="padding: 10px; background: rgba(255,255,255,0.05); margin-bottom: 5px; border-radius: 5px;">
                        <span style="color: var(--primary);">${new Date(record.timestamp).toLocaleString('zh-TW')}</span>
                        <span style="float: right; font-weight: 600;">${record.state} ${record.attributes?.unit_of_measurement || ''}</span>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
    
    container.innerHTML = html;
}

function renderSystemInfo(data) {
    const container = document.getElementById('systemInfo');
    
    const memUsage = parseFloat(data.memory?.percentage || 0);
    
    container.innerHTML = `
        <div style="line-height: 2;">
            <div><strong>主機名稱:</strong> ${data.hostname}</div>
            <div><strong>平台:</strong> ${data.platform}</div>
            <div><strong>架構:</strong> ${data.arch}</div>
            <div><strong>CPU 核心:</strong> ${data.cpus}</div>
            <div><strong>運行時間:</strong> ${formatUptime(data.uptime)}</div>
            <div style="margin-top: 15px;">
                <strong>記憶體使用:</strong> ${memUsage.toFixed(1)}%
                <div style="width: 100%; height: 20px; background: rgba(255,255,255,0.1); border-radius: 10px; margin-top: 5px; overflow: hidden;">
                    <div style="width: ${memUsage}%; height: 100%; background: linear-gradient(90deg, var(--success), var(--warning)); transition: width 0.5s;"></div>
                </div>
            </div>
        </div>
    `;
}

// ==================== 實體操作 ====================

async function toggleEntity(entityId) {
    const entity = entities.find(e => e.entity_id === entityId);
    if (!entity) return;
    
    const newState = entity.state === 'on' ? 'off' : 'on';
    const service = newState === 'on' ? 'turn_on' : 'turn_off';
    const domain = entityId.split('.')[0];
    
    try {
        const response = await fetch(`${API_BASE}/api/services/${domain}/${service}`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${AUTH}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ entity_id: entityId })
        });
        
        if (response.ok) {
            await refreshEntities();
            addLog(`${entityId} 已${newState === 'on' ? '開啟' : '關閉'}`);
        }
    } catch (error) {
        console.error('操作失敗:', error);
        addLog(`操作失敗: ${error.message}`, 'error');
    }
}

async function deleteEntity(entityId) {
    if (!confirm(`確定要刪除實體 ${entityId} 嗎？`)) return;
    
    try {
        const response = await fetch(`${API_BASE}/api/entities/${entityId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Basic ${AUTH}` }
        });
        
        if (response.ok) {
            await refreshEntities();
            addLog(`已刪除實體: ${entityId}`);
        }
    } catch (error) {
        console.error('刪除失敗:', error);
    }
}

async function createEntity(event) {
    event.preventDefault();
    const form = event.target;
    const formData = new FormData(form);
    
    const data = {
        entity_id: formData.get('entity_id'),
        state: formData.get('state'),
        attributes: {
            friendly_name: formData.get('friendly_name')
        }
    };
    
    try {
        const response = await fetch(`${API_BASE}/api/entities`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${AUTH}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });
        
        if (response.ok) {
            await refreshEntities();
            closeModal('createEntityModal');
            form.reset();
            addLog(`已創建實體: ${data.entity_id}`);
            showNotification('成功', '實體已創建');
        }
    } catch (error) {
        console.error('創建失敗:', error);
        showNotification('錯誤', '創建失敗: ' + error.message);
    }
}

// ==================== 自動化操作 ====================

async function toggleAutomation(id) {
    try {
        const response = await fetch(`${API_BASE}/api/automations/${id}/toggle`, {
            method: 'POST',
            headers: { 'Authorization': `Basic ${AUTH}` }
        });
        
        if (response.ok) {
            await loadAutomations();
            addLog(`自動化狀態已切換`);
        }
    } catch (error) {
        console.error('操作失敗:', error);
    }
}

async function deleteAutomation(id) {
    if (!confirm('確定要刪除此自動化嗎？')) return;
    
    try {
        const response = await fetch(`${API_BASE}/api/automations/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Basic ${AUTH}` }
        });
        
        if (response.ok) {
            await loadAutomations();
            addLog('自動化已刪除');
        }
    } catch (error) {
        console.error('刪除失敗:', error);
    }
}

async function createAutomation(event) {
    event.preventDefault();
    const form = event.target;
    const formData = new FormData(form);
    
    try {
        const data = {
            name: formData.get('name'),
            description: formData.get('description'),
            triggers: JSON.parse(formData.get('triggers')),
            conditions: [],
            actions: JSON.parse(formData.get('actions'))
        };
        
        const response = await fetch(`${API_BASE}/api/automations`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${AUTH}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });
        
        if (response.ok) {
            await loadAutomations();
            closeModal('createAutomationModal');
            form.reset();
            addLog(`已創建自動化: ${data.name}`);
            showNotification('成功', '自動化已創建');
        }
    } catch (error) {
        console.error('創建失敗:', error);
        showNotification('錯誤', '創建失敗，請檢查 JSON 格式');
    }
}

// ==================== 場景操作 ====================

async function activateScene(id) {
    try {
        const response = await fetch(`${API_BASE}/api/scenes/${id}/activate`, {
            method: 'POST',
            headers: { 'Authorization': `Basic ${AUTH}` }
        });
        
        if (response.ok) {
            const scene = scenes.find(s => s.id === id);
            addLog(`場景 "${scene?.name}" 已激活`);
            showNotification('場景激活', scene?.name || '');
            setTimeout(refreshEntities, 500);
        }
    } catch (error) {
        console.error('激活失敗:', error);
    }
}

async function deleteScene(id) {
    if (!confirm('確定要刪除此場景嗎？')) return;
    
    try {
        const response = await fetch(`${API_BASE}/api/scenes/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Basic ${AUTH}` }
        });
        
        if (response.ok) {
            await loadScenes();
            addLog('場景已刪除');
        }
    } catch (error) {
        console.error('刪除失敗:', error);
    }
}

async function createScene(event) {
    event.preventDefault();
    const form = event.target;
    const formData = new FormData(form);
    
    try {
        const data = {
            name: formData.get('name'),
            description: formData.get('description'),
            entities: JSON.parse(formData.get('entities'))
        };
        
        const response = await fetch(`${API_BASE}/api/scenes`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${AUTH}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });
        
        if (response.ok) {
            await loadScenes();
            closeModal('createSceneModal');
            form.reset();
            addLog(`已創建場景: ${data.name}`);
            showNotification('成功', '場景已創建');
        }
    } catch (error) {
        console.error('創建失敗:', error);
        showNotification('錯誤', '創建失敗，請檢查 JSON 格式');
    }
}

// ==================== UI 工具函數 ====================

function switchTab(tabName, navElement) {
    // 更新導航項
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    if (navElement) {
        navElement.classList.add('active');
    }
    
    // 更新內容
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.getElementById(tabName).classList.add('active');

    // 關閉側邊欄
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarBackdrop').classList.remove('open');
    document.getElementById('sidebarToggle').classList.remove('open');
    
    // 載入對應數據
    if (tabName === 'history') {
        updateHistoryEntitySelect();
    }
}

function showModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

function showCreateEntityModal() {
    showModal('createEntityModal');
}

function showCreateAutomationModal() {
    showModal('createAutomationModal');
}

function showCreateSceneModal() {
    showModal('createSceneModal');
}

function showNotification(title, message) {
    const container = document.getElementById('notificationContainer');
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 5px;">${title}</div>
        <div style="font-size: 0.9em;">${message}</div>
    `;
    
    container.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

function addLog(message, type = 'info') {
    const container = document.getElementById('logContainer');
    const time = new Date().toLocaleTimeString('zh-TW');
    const color = type === 'error' ? 'var(--danger)' : 'var(--text-secondary)';
    
    const log = document.createElement('div');
    log.style.padding = '8px';
    log.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
    log.innerHTML = `<span style="color: ${color};">[${time}]</span> ${message}`;
    
    container.insertBefore(log, container.firstChild);
    
    // 只保留最新 100 條
    while (container.children.length > 100) {
        container.removeChild(container.lastChild);
    }
}

function clearLogs() {
    document.getElementById('logContainer').innerHTML = '';
    addLog('日誌已清除');
}

function updateEntityCounts(entityList) {
    document.getElementById('entityCount').textContent = entityList.length;
}

function updateStatCards() {
    const switchesOn = entities.filter(e => 
        e.entity_id.startsWith('switch.') && e.state === 'on'
    ).length;
    const sensorsCount = entities.filter(e => 
        e.entity_id.startsWith('sensor.')
    ).length;
    
    const statSwitchesOn = document.getElementById('statSwitchesOn');
    const statSensors = document.getElementById('statSensors');
    const statAutomations = document.getElementById('statAutomations');
    const statScenes = document.getElementById('statScenes');
    
    if (statSwitchesOn) statSwitchesOn.textContent = switchesOn;
    if (statSensors) statSensors.textContent = sensorsCount;
    if (statAutomations) statAutomations.textContent = automations.length;
    if (statScenes) statScenes.textContent = scenes.length;
}

function updateHistoryEntitySelect() {
    const select = document.getElementById('historyEntity');
    select.innerHTML = '<option value="">選擇實體...</option>' +
        entities.filter(e => e.entity_id.startsWith('sensor.')).map(e => 
            `<option value="${e.entity_id}">${e.attributes?.friendly_name || e.entity_id}</option>`
        ).join('');
}

async function updateEntityInList(entityId) {
    // 重新載入單個實體
    try {
        const response = await fetch(`${API_BASE}/api/entities/${entityId}`);
        const entity = await response.json();
        
        const index = entities.findIndex(e => e.entity_id === entityId);
        if (index !== -1) {
            entities[index] = entity;
            renderSwitches();
            renderSensors();
        }
    } catch (error) {
        console.error('更新實體失敗:', error);
    }
}

function formatUptime(seconds) {
    if (!seconds) return '--';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${days}天 ${hours}時 ${minutes}分`;
}

async function refreshEntities() {
    await loadEntities();
    addLog('已刷新實體列表');
}

// 定期刷新
setInterval(() => {
    loadSystemInfo();
}, 30000);

// ==================== 快速操作 ====================

let quickActionPanelOpen = false;

function showQuickActions() {
    if (quickActionPanelOpen) {
        closeQuickActions();
        return;
    }
    
    const panel = document.createElement('div');
    panel.id = 'quickActionPanel';
    panel.className = 'quick-action-panel';
    panel.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 15px; color: var(--primary);">⚡ 快速動作</div>
        <div class="quick-action-item" onclick="turnAllOn()">
            <div style="font-weight: 600;">🔆 全部開啟</div>
            <div style="font-size: 0.85em; color: var(--text-secondary);">開啟所有開關</div>
        </div>
        <div class="quick-action-item" onclick="turnAllOff()">
            <div style="font-weight: 600;">🌙 全部關閉</div>
            <div style="font-size: 0.85em; color: var(--text-secondary);">關閉所有開關</div>
        </div>
        <div class="quick-action-item" onclick="refreshAllData()">
            <div style="font-weight: 600;">🔄 刷新數據</div>
            <div style="font-size: 0.85em; color: var(--text-secondary);">重新載入所有數據</div>
        </div>
        <div class="quick-action-item" onclick="exportConfig()">
            <div style="font-weight: 600;">💾 匯出設定</div>
            <div style="font-size: 0.85em; color: var(--text-secondary);">下載配置檔案</div>
        </div>
        <div class="quick-action-item" onclick="closeQuickActions(); showModal('createEntityModal');">
            <div style="font-weight: 600;">➕ 新增實體</div>
            <div style="font-size: 0.85em; color: var(--text-secondary);">創建新實體</div>
        </div>
    `;
    
    document.body.appendChild(panel);
    quickActionPanelOpen = true;
    
    // 點擊外部關閉
    setTimeout(() => {
        document.addEventListener('click', handleQuickActionClickOutside);
    }, 100);
}

function closeQuickActions() {
    const panel = document.getElementById('quickActionPanel');
    if (panel) {
        panel.remove();
    }
    quickActionPanelOpen = false;
    document.removeEventListener('click', handleQuickActionClickOutside);
}

function handleQuickActionClickOutside(e) {
    const panel = document.getElementById('quickActionPanel');
    const fab = document.querySelector('.floating-action-button');
    
    if (panel && !panel.contains(e.target) && !fab.contains(e.target)) {
        closeQuickActions();
    }
}

async function turnAllOn() {
    const switches = entities.filter(e => e.entity_id.startsWith('switch.'));
    let count = 0;
    
    for (const entity of switches) {
        if (entity.state !== 'on') {
            await toggleEntity(entity.entity_id);
            count++;
        }
    }
    
    showNotification('批量操作', `已開啟 ${count} 個開關`);
    closeQuickActions();
}

async function turnAllOff() {
    const switches = entities.filter(e => e.entity_id.startsWith('switch.'));
    let count = 0;
    
    for (const entity of switches) {
        if (entity.state !== 'off') {
            await toggleEntity(entity.entity_id);
            count++;
        }
    }
    
    showNotification('批量操作', `已關閉 ${count} 個開關`);
    closeQuickActions();
}

async function refreshAllData() {
    await loadAllData();
    showNotification('刷新完成', '所有數據已重新載入');
    closeQuickActions();
}

function exportConfig() {
    const config = {
        entities: entities,
        automations: automations,
        scenes: scenes,
        export_time: new Date().toISOString(),
        version: '2.0.0'
    };
    
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wi-care-config-${new Date().getTime()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    showNotification('匯出成功', '配置檔案已下載');
    closeQuickActions();
}

// ==================== 群組管理 ====================

async function loadGroups() {
    try {
        const response = await fetch(`${API_BASE}/api/groups`);
        groups = await response.json();
        renderGroups();
    } catch (error) {
        console.error('載入群組失敗:', error);
    }
}

function renderGroups() {
    const container = document.getElementById('groupList');
    
    if (groups.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">👥</div><div>尚未創建任何群組<br>點擊上方按鈕創建第一個群組</div></div>';
        return;
    }
    
    container.innerHTML = groups.map(group => `
        <div class="automation-item">
            <div class="item-header">
                <div class="item-title">${group.name}</div>
            </div>
            <div style="font-size: 0.85em; color: var(--text-secondary); margin-bottom: 10px;">
                包含 ${group.entity_ids?.length || 0} 個實體
            </div>
            <div class="item-actions">
                <button class="btn btn-small btn-success" onclick="controlGroup('${group.id}', 'turn_on')">全部開啟</button>
                <button class="btn btn-small" onclick="controlGroup('${group.id}', 'turn_off')">全部關閉</button>
                <button class="btn btn-small btn-danger" onclick="deleteGroup('${group.id}')">刪除</button>
            </div>
        </div>
    `).join('');
}

async function createGroup(event) {
    event.preventDefault();
    const form = event.target;
    const formData = new FormData(form);
    
    const data = {
        name: formData.get('name'),
        entity_ids: formData.get('entity_ids').split(',').map(id => id.trim()),
        icon: formData.get('icon')
    };
    
    try {
        const response = await fetch(`${API_BASE}/api/groups`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${AUTH}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });
        
        if (response.ok) {
            await loadGroups();
            closeModal('createGroupModal');
            form.reset();
            showNotification('成功', '群組已創建');
        }
    } catch (error) {
        console.error('創建失敗:', error);
        showNotification('錯誤', '創建失敗');
    }
}

async function controlGroup(id, service) {
    try {
        const response = await fetch(`${API_BASE}/api/groups/${id}/${service}`, {
            method: 'POST',
            headers: { 'Authorization': `Basic ${AUTH}` }
        });
        
        if (response.ok) {
            await refreshEntities();
            showNotification('成功', `群組${service === 'turn_on' ? '已開啟' : '已關閉'}`);
        }
    } catch (error) {
        console.error('操作失敗:', error);
    }
}

async function deleteGroup(id) {
    if (!confirm('確定要刪除此群組嗎？')) return;
    
    try {
        const response = await fetch(`${API_BASE}/api/groups/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Basic ${AUTH}` }
        });
        
        if (response.ok) {
            await loadGroups();
            showNotification('成功', '群組已刪除');
        }
    } catch (error) {
        console.error('刪除失敗:', error);
    }
}

function showCreateGroupModal() {
    showModal('createGroupModal');
}

// ==================== 腳本管理 ====================

async function loadScripts() {
    try {
        const response = await fetch(`${API_BASE}/api/scripts`);
        scripts = await response.json();
        renderScripts();
    } catch (error) {
        console.error('載入腳本失敗:', error);
    }
}

function renderScripts() {
    const container = document.getElementById('scriptList');
    
    if (scripts.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📜</div><div>尚未創建任何腳本<br>點擊上方按鈕創建第一個腳本</div></div>';
        return;
    }
    
    container.innerHTML = scripts.map(script => `
        <div class="automation-item">
            <div class="item-header">
                <div class="item-title">${script.name}</div>
            </div>
            ${script.description ? `<div class="item-description">${script.description}</div>` : ''}
            <div style="font-size: 0.85em; color: var(--text-secondary); margin-bottom: 10px;">
                動作數: ${script.sequence?.length || 0}
                ${script.last_triggered ? `<br>最後執行: ${new Date(script.last_triggered).toLocaleString('zh-TW')}` : ''}
            </div>
            <div class="item-actions">
                <button class="btn btn-small btn-success" onclick="executeScript('${script.id}')">執行</button>
                <button class="btn btn-small btn-danger" onclick="deleteScript('${script.id}')">刪除</button>
            </div>
        </div>
    `).join('');
}

async function createScript(event) {
    event.preventDefault();
    const form = event.target;
    const formData = new FormData(form);
    
    try {
        const data = {
            name: formData.get('name'),
            description: formData.get('description'),
            sequence: JSON.parse(formData.get('sequence'))
        };
        
        const response = await fetch(`${API_BASE}/api/scripts`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${AUTH}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });
        
        if (response.ok) {
            await loadScripts();
            closeModal('createScriptModal');
            form.reset();
            showNotification('成功', '腳本已創建');
        }
    } catch (error) {
        console.error('創建失敗:', error);
        showNotification('錯誤', '創建失敗，請檢查 JSON 格式');
    }
}

async function executeScript(id) {
    try {
        const response = await fetch(`${API_BASE}/api/scripts/${id}/execute`, {
            method: 'POST',
            headers: { 'Authorization': `Basic ${AUTH}` }
        });
        
        if (response.ok) {
            showNotification('成功', '腳本已執行');
            await loadScripts();
        }
    } catch (error) {
        console.error('執行失敗:', error);
    }
}

async function deleteScript(id) {
    if (!confirm('確定要刪除此腳本嗎？')) return;
    
    try {
        const response = await fetch(`${API_BASE}/api/scripts/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Basic ${AUTH}` }
        });
        
        if (response.ok) {
            await loadScripts();
            showNotification('成功', '腳本已刪除');
        }
    } catch (error) {
        console.error('刪除失敗:', error);
    }
}

function showCreateScriptModal() {
    showModal('createScriptModal');
}

// ==================== 輸入助手管理 ====================

async function loadHelpers() {
    try {
        const response = await fetch(`${API_BASE}/api/input_helpers`);
        helpers = await response.json();
        renderHelpers();
    } catch (error) {
        console.error('載入輸入助手失敗:', error);
    }
}

function renderHelpers() {
    const container = document.getElementById('helperList');
    
    if (helpers.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🎛️</div><div>尚未創建任何輸入助手<br>點擊上方按鈕創建</div></div>';
        return;
    }
    
    container.innerHTML = helpers.map(helper => {
        const entity = entities.find(e => e.entity_id === helper.entity_id);
        return `
            <div class="entity-item">
                <div class="entity-info">
                    <div class="entity-name">${helper.name}</div>
                    <div class="entity-id">${helper.entity_id} (${helper.type})</div>
                </div>
                <div class="entity-state">
                    <span class="state-badge state-on">${entity?.state || helper.state}</span>
                    <button class="btn btn-small btn-danger" onclick="deleteHelper('${helper.entity_id}')">刪除</button>
                </div>
            </div>
        `;
    }).join('');
}

async function showCreateHelperModal(type) {
    const modal = document.getElementById('createHelperModal');
    const form = document.getElementById('createHelperForm');
    const title = document.getElementById('helperModalTitle');
    const typeField = document.getElementById('helperType');
    const specificFields = document.getElementById('helperSpecificFields');
    
    typeField.value = type;
    title.textContent = `新增 Input ${type.charAt(0).toUpperCase() + type.slice(1)}`;
    
    // 根據類型顯示特定欄位
    let fieldsHTML = '';
    switch (type) {
        case 'boolean':
            fieldsHTML = `
                <div class="form-group">
                    <label class="form-label">初始狀態</label>
                    <select class="form-input" name="initial">
                        <option value="off">Off</option>
                        <option value="on">On</option>
                    </select>
                </div>
            `;
            break;
        case 'number':
            fieldsHTML = `
                <div class="form-group">
                    <label class="form-label">最小值</label>
                    <input type="number" class="form-input" name="min" value="0">
                </div>
                <div class="form-group">
                    <label class="form-label">最大值</label>
                    <input type="number" class="form-input" name="max" value="100">
                </div>
                <div class="form-group">
                    <label class="form-label">步進</label>
                    <input type="number" class="form-input" name="step" value="1">
                </div>
                <div class="form-group">
                    <label class="form-label">單位</label>
                    <input type="text" class="form-input" name="unit" placeholder="例如: %, °C">
                </div>
            `;
            break;
        case 'select':
            fieldsHTML = `
                <div class="form-group">
                    <label class="form-label">選項（逗號分隔）</label>
                    <input type="text" class="form-input" name="options" placeholder="選項1,選項2,選項3" required>
                </div>
            `;
            break;
        case 'text':
            fieldsHTML = `
                <div class="form-group">
                    <label class="form-label">初始值</label>
                    <input type="text" class="form-input" name="initial">
                </div>
                <div class="form-group">
                    <label class="form-label">最大長度</label>
                    <input type="number" class="form-input" name="max" value="255">
                </div>
            `;
            break;
    }
    
    specificFields.innerHTML = fieldsHTML;
    showModal('createHelperModal');
}

async function createHelper(event) {
    event.preventDefault();
    const form = event.target;
    const formData = new FormData(form);
    const type = formData.get('helper_type');
    
    const data = {
        name: formData.get('name'),
        friendly_name: formData.get('friendly_name') || formData.get('name')
    };
    
    // 根據類型添加特定欄位
    switch (type) {
        case 'boolean':
            data.initial = formData.get('initial');
            break;
        case 'number':
            data.min = parseInt(formData.get('min'));
            data.max = parseInt(formData.get('max'));
            data.step = parseFloat(formData.get('step'));
            data.unit = formData.get('unit');
            break;
        case 'select':
            data.options = formData.get('options').split(',').map(o => o.trim());
            break;
        case 'text':
            data.initial = formData.get('initial');
            data.max = parseInt(formData.get('max'));
            break;
    }
    
    try {
        const response = await fetch(`${API_BASE}/api/input_helpers/${type}`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${AUTH}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });
        
        if (response.ok) {
            await loadHelpers();
            await loadEntities();
            closeModal('createHelperModal');
            form.reset();
            showNotification('成功', '輸入助手已創建');
        }
    } catch (error) {
        console.error('創建失敗:', error);
        showNotification('錯誤', '創建失敗');
    }
}

async function deleteHelper(entityId) {
    if (!confirm('確定要刪除此輸入助手嗎？')) return;
    
    try {
        const response = await fetch(`${API_BASE}/api/input_helpers/${entityId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Basic ${AUTH}` }
        });
        
        if (response.ok) {
            await loadHelpers();
            await loadEntities();
            showNotification('成功', '輸入助手已刪除');
        }
    } catch (error) {
        console.error('刪除失敗:', error);
    }
}

// ==================== 區域管理 ====================

async function loadAreas() {
    try {
        const response = await fetch(`${API_BASE}/api/areas`);
        areas = await response.json();
        renderAreas();
    } catch (error) {
        console.error('載入區域失敗:', error);
    }
}

function renderAreas() {
    const container = document.getElementById('areaList');
    
    if (areas.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🏠</div><div>尚未創建任何區域<br>點擊上方按鈕創建第一個區域</div></div>';
        return;
    }
    
    container.innerHTML = areas.map(area => `
        <div class="automation-item">
            <div class="item-header">
                <div class="item-title">${area.name}</div>
            </div>
            <div style="font-size: 0.85em; color: var(--text-secondary); margin-bottom: 10px;">
                包含 ${area.entity_ids?.length || 0} 個實體
            </div>
            <div class="item-actions">
                <button class="btn btn-small btn-danger" onclick="deleteArea('${area.id}')">刪除</button>
            </div>
        </div>
    `).join('');
}

async function createArea(event) {
    event.preventDefault();
    const form = event.target;
    const formData = new FormData(form);
    
    const data = {
        name: formData.get('name'),
        icon: formData.get('icon')
    };
    
    try {
        const response = await fetch(`${API_BASE}/api/areas`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${AUTH}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });
        
        if (response.ok) {
            await loadAreas();
            closeModal('createAreaModal');
            form.reset();
            showNotification('成功', '區域已創建');
        }
    } catch (error) {
        console.error('創建失敗:', error);
        showNotification('錯誤', '創建失敗');
    }
}

async function deleteArea(id) {
    if (!confirm('確定要刪除此區域嗎？')) return;
    
    try {
        const response = await fetch(`${API_BASE}/api/areas/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Basic ${AUTH}` }
        });
        
        if (response.ok) {
            await loadAreas();
            showNotification('成功', '區域已刪除');
        }
    } catch (error) {
        console.error('刪除失敗:', error);
    }
}

function showCreateAreaModal() {
    showModal('createAreaModal');
}

// ==================== 通知管理 ====================

async function loadNotifications() {
    try {
        const response = await fetch(`${API_BASE}/api/notifications`);
        notifications = await response.json();
        renderNotifications();
    } catch (error) {
        console.error('載入通知失敗:', error);
    }
}

function renderNotifications() {
    // 通知會透過 WebSocket 即時顯示
    notifications.forEach(notif => {
        if (notif.persistent && !document.querySelector(`[data-notif-id="${notif.id}"]`)) {
            const container = document.getElementById('notificationContainer');
            const div = document.createElement('div');
            div.className = 'notification';
            div.setAttribute('data-notif-id', notif.id);
            div.innerHTML = `
                <div style="font-weight: 600; margin-bottom: 5px;">${notif.title}</div>
                <div style="font-size: 0.9em;">${notif.message}</div>
            `;
            container.appendChild(div);
        }
    });
}

