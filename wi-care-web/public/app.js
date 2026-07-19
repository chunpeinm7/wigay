// Wi-Care 看護監測系統 前端

const API_BASE = window.location.origin;
const WS_URL = `ws://${window.location.host}`;
const AUTH = btoa('admin:admin123');

let ws = null;
let entities = [];
let logEntries = [];

// ====== 初始化 ======

document.addEventListener('DOMContentLoaded', async () => {
    startClock();
    initWebSocket();
    await loadEntities();
    await loadSystemInfo();
    addLog('系統已啟動，開始監測病房狀態', 'success');
});

// ====== 時鐘 ======

function startClock() {
    function tick() {
        const now = new Date();
        document.getElementById('clock').textContent =
            now.toLocaleString('zh-TW', {
                month: 'numeric', day: 'numeric',
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
    }
    tick();
    setInterval(tick, 1000);
}

// ====== WebSocket ======

function initWebSocket() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        updateConn(true);
        addLog('即時連線已建立', 'success');
    };

    ws.onclose = () => {
        updateConn(false);
        addLog('連線中斷，3 秒後重新連線...', 'warn');
        setTimeout(initWebSocket, 3000);
    };

    ws.onerror = () => {};

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleMessage(data);
    };
}

function handleMessage(data) {
    switch (data.type) {
        case 'state_changed': {
            const entity = entities.find(e => e.entity_id === data.entity_id);
            const name = entity?.attributes?.friendly_name || data.entity_id;
            if (data.entity_id.startsWith('switch.')) {
                const wasActive = data.old_state === 'on';
                const isActive = data.new_state === 'on';
                if (wasActive && !isActive) {
                    addLog(`${name} 活動停止，進入靜止狀態`, 'warn');
                    showToast('活動變化', `${name} 目前無偵測到活動`, 'warn');
                } else if (!wasActive && isActive) {
                    addLog(`${name} 偵測到活動`, 'success');
                }
            }
            refreshEntities();
            break;
        }
        case 'notification':
            showToast(data.title, data.message);
            addLog(data.message, 'info');
            break;
    }
}

function updateConn(connected) {
    const badge = document.getElementById('connBadge');
    const text = document.getElementById('connText');
    if (connected) {
        badge.classList.remove('off');
        text.textContent = '已連線';
    } else {
        badge.classList.add('off');
        text.textContent = '已斷線';
    }
}

// ====== 資料載入 ======

async function loadEntities() {
    try {
        const res = await fetch(`${API_BASE}/api/entities`);
        entities = await res.json();
        renderFloorPlan();
        renderEnv();
        updateSummary();
    } catch (e) {
        addLog('載入住民資料失敗: ' + e.message, 'error');
    }
}

async function refreshEntities() {
    await loadEntities();
}

async function loadSystemInfo() {
    try {
        const res = await fetch(`${API_BASE}/api/system`);
        const data = await res.json();
        renderSystemInfo(data);
    } catch (e) {
        addLog('載入系統資訊失敗', 'error');
    }
}

// ====== 渲染：病房平面圖 ======

let currentRoomId = null;
let currentFloor = 1;

function getRoomStatus(bed) {
    const isActive = bed.state === 'on';
    const lastTime = new Date(bed.last_changed);
    const minutesAgo = Math.floor((Date.now() - lastTime.getTime()) / 60000);
    const isAlert = !isActive && minutesAgo > 60;
    return { isActive, isAlert, minutesAgo, lastTime };
}

function getFloorRooms(floor) {
    const beds = entities.filter(e => e.entity_id.startsWith('switch.'));
    if (floor === 1) {
        return beds.filter(b => {
            const name = b.attributes?.friendly_name || '';
            return name.startsWith('1');
        });
    } else {
        return beds.filter(b => {
            const name = b.attributes?.friendly_name || '';
            return name.startsWith('2');
        });
    }
}

function switchFloor(floor) {
    currentFloor = floor;
    document.getElementById('floorBtn1').classList.toggle('active', floor === 1);
    document.getElementById('floorBtn2').classList.toggle('active', floor === 2);
    document.getElementById('floorPlanTitle').textContent = `Wi-Care 病房樓層配置 — ${floor}F`;
    renderFloorPlan();
    updateSummary();
}

function renderFloorPlan() {
    const rooms = getFloorRooms(currentFloor);

    if (rooms.length === 0) return;

    const topRooms = rooms.slice(0, 6);
    const bottomRooms = rooms.slice(6);

    const topGrid = document.getElementById('floorTop');
    const bottomGrid = document.getElementById('floorBottom');

    topGrid.innerHTML = topRooms.map(bed => renderRoomBlock(bed)).join('');
    bottomGrid.innerHTML = bottomRooms.map(bed => renderRoomBlock(bed)).join('');

    // If we're viewing a room detail, refresh it too
    if (currentRoomId) {
        const room = entities.find(e => e.entity_id === currentRoomId);
        if (room) renderRoomDetail(room);
    }
}

function renderRoomBlock(bed) {
    const name = bed.attributes?.friendly_name || bed.entity_id;
    const { isActive, isAlert, minutesAgo } = getRoomStatus(bed);
    const isDisconnected = bed.attributes?.device_connected === false;

    let cardClass = isAlert ? 'alert' : (isActive ? 'active' : 'inactive');
    if (isDisconnected) cardClass = 'disconnected';
    const dotClass = isDisconnected ? 'off' : (isAlert ? 'alert' : (isActive ? 'on' : 'off'));
    const statusText = isDisconnected ? '已斷線' : (isAlert ? '需要關注' : (isActive ? '有活動' : '靜止中'));

    const disconnectOverlay = isDisconnected ? `
        <div class="room-disconnect-overlay">
            <div class="room-disconnect-icon">!</div>
        </div>
    ` : '';

    return `
        <div class="room-block ${cardClass}" onclick="openRoom('${bed.entity_id}')">
            <div class="room-header">
                <span class="room-label">${name}</span>
                <span class="room-status-dot ${dotClass}"></span>
            </div>
            <div class="room-interior">
                <div class="room-bed"></div>
                <div class="room-nightstand"></div>
                <div class="room-door"></div>
                <div class="room-status-text">${statusText}</div>
                ${disconnectOverlay}
            </div>
        </div>
    `;
}

function openRoom(entityId) {
    const bed = entities.find(e => e.entity_id === entityId);
    if (!bed) return;

    currentRoomId = entityId;
    document.getElementById('floorPlanView').style.display = 'none';
    const detailView = document.getElementById('roomDetailView');
    detailView.classList.add('active');

    renderRoomDetail(bed);
}

function renderRoomDetail(bed) {
    const name = bed.attributes?.friendly_name || bed.entity_id;
    const { isActive, isAlert, minutesAgo, lastTime } = getRoomStatus(bed);

    const statusText = isAlert ? '需要關注' : (isActive ? '有活動' : '靜止中');
    const badgeClass = isAlert ? 'alert' : (isActive ? 'on' : 'off');

    // Top bar
    document.getElementById('roomDetailTitle').textContent = name;
    const badge = document.getElementById('roomDetailBadge');
    badge.className = 'room-detail-badge ' + badgeClass;
    badge.textContent = statusText;

    // Clock in topbar
    function updateHtermClock() {
        const now = new Date();
        document.getElementById('htermClock').textContent = now.toLocaleString('zh-TW', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
    }
    updateHtermClock();
    if (window._htermClockInterval) clearInterval(window._htermClockInterval);
    window._htermClockInterval = setInterval(updateHtermClock, 1000);

    const timeStr = minutesAgo < 1 ? '剛剛' :
                    minutesAgo < 60 ? `${minutesAgo} 分鐘前` :
                    minutesAgo < 1440 ? `${Math.floor(minutesAgo/60)} 小時前` :
                    `${Math.floor(minutesAgo/1440)} 天前`;

    // Patient meta (gender, age, etc.)
    const age = bed.attributes?.age;
    const metaParts = [];
    if (bed.attributes?.gender) metaParts.push(bed.attributes.gender);
    if (age) metaParts.push(age + '歲');
    metaParts.push('最後偵測：' + timeStr);
    document.getElementById('htermPatientMeta').textContent = metaParts.join('　');

    // Patient name
    document.getElementById('htermPatientName').textContent = bed.attributes?.resident_name || '（未登記住民）';

    // Badges
    const badgesDiv = document.getElementById('htermBadges');
    let badgesHtml = '';
    const isDisconnected = bed.attributes?.device_connected === false;
    const statusBadgeClass = isAlert ? 'status-alert' : (isActive ? 'status-on' : 'status-off');
    badgesHtml += `<span class="hterm-badge ${statusBadgeClass}">${statusText}</span>`;
    if (isDisconnected) {
        badgesHtml += `<span class="hterm-badge disconnected">設備已斷線</span>`;
    } else {
        badgesHtml += `<span class="hterm-badge connected">設備已連線</span>`;
    }
    badgesHtml += `<span class="hterm-badge info">${bed.entity_id}</span>`;
    if (bed.attributes?.note) {
        badgesHtml += `<span class="hterm-badge info">${escapeHtml(bed.attributes.note)}</span>`;
    }
    badgesDiv.innerHTML = badgesHtml;

    // Function buttons grid
    const funcGrid = document.getElementById('htermFuncGrid');
    let funcHtml = `
        <button class="hterm-func-btn" onclick="openEditModal('${bed.entity_id}')">
            <span class="func-label">編輯資料</span>
        </button>
        <button class="hterm-func-btn" onclick="openCareRecordsPanel('${bed.entity_id}')">
            <span class="func-label">過往紀錄</span>
        </button>
        <button class="hterm-func-btn" onclick="showRoomInfo('${bed.entity_id}')">
            <span class="func-label">詳細資訊</span>
        </button>
        <button class="hterm-func-btn" onclick="showVitalSigns()">
            <span class="func-label">生命徵象</span>
        </button>
        <button class="hterm-func-btn" onclick="showMedInfo()">
            <span class="func-label">用藥資訊</span>
        </button>
        <button class="hterm-func-btn" onclick="showCareNotes()">
            <span class="func-label">護理紀錄</span>
        </button>
    `;
    if (isAlert) {
        funcHtml += `
            <button class="hterm-func-btn danger-btn" onclick="dismissAlert('${bed.entity_id}')">
                <span class="func-label">關閉警報</span>
            </button>
        `;
    }
    funcGrid.innerHTML = funcHtml;

    // Right side: quick actions
    const quickActions = document.getElementById('htermQuickActions');
    quickActions.innerHTML = `
        <button class="hterm-quick-btn" onclick="showToast('已通知', '護理師已收到呼叫', 'success')">
            <span class="qact-label">呼叫護理師</span>
        </button>
        <button class="hterm-quick-btn" onclick="showToast('已通知', '環境清潔已排程', 'success')">
            <span class="qact-label">環境清潔</span>
        </button>
        <button class="hterm-quick-btn" onclick="showToast('已通知', '協助如廁需求已發送', 'success')">
            <span class="qact-label">協助如廁</span>
        </button>
        <button class="hterm-quick-btn" onclick="showToast('已通知', '更換點滴需求已發送', 'success')">
            <span class="qact-label">更換點滴</span>
        </button>
    `;

    // Right side: care team
    const teamCard = document.getElementById('htermTeamCard');
    const doctor = bed.attributes?.doctor || '--';
    const nurse = bed.attributes?.nurse || '--';
    const supervisor = bed.attributes?.supervisor || '--';
    teamCard.innerHTML = `
        <div class="hterm-team-title">照護團隊</div>
        <div class="hterm-team-row">
            <span class="hterm-team-label">主治醫師</span>
            <span class="hterm-team-value">${escapeHtml(doctor)}</span>
        </div>
        <div class="hterm-team-row">
            <span class="hterm-team-label">主護護理師</span>
            <span class="hterm-team-value">${escapeHtml(nurse)}</span>
        </div>
        <div class="hterm-team-row">
            <span class="hterm-team-label">護理長</span>
            <span class="hterm-team-value">${escapeHtml(supervisor)}</span>
        </div>
    `;

    // Bottom bar
    const bottomBar = document.getElementById('htermBottomBar');
    if (isAlert) {
        bottomBar.className = 'hterm-bottom-bar';
        bottomBar.innerHTML = `<span class="ticker">注意事項：${name} 目前${statusText}，已超過 ${minutesAgo} 分鐘未偵測到活動，請盡速前往查看。</span>`;
    } else {
        bottomBar.className = 'hterm-bottom-bar normal';
        bottomBar.innerHTML = `<span class="ticker">${name} 狀態正常 — 最後偵測：${timeStr}（${lastTime.toLocaleTimeString('zh-TW', {hour:'2-digit', minute:'2-digit'})}）— Wi-Care 看護監測系統持續守護中</span>`;
    }

    // Hide old floating actions (no longer needed)
    document.getElementById('roomActions').style.display = 'none';
}

function backToFloorPlan() {
    currentRoomId = null;
    if (window._htermClockInterval) clearInterval(window._htermClockInterval);
    document.getElementById('floorPlanView').style.display = 'block';
    document.getElementById('roomDetailView').classList.remove('active');
    document.getElementById('roomActions').style.display = 'none';
    document.getElementById('careRecordsPanel').style.display = 'none';
}

function openCareRecordsPanel(entityId) {
    const panel = document.getElementById('careRecordsPanel');
    panel.style.display = 'flex';
    const list = document.getElementById('careRecordsList');
    list.innerHTML = '<div class="care-records-empty">載入中...</div>';
    renderCareRecords(entityId, list);
}

function closeCareRecordsPanel() {
    document.getElementById('careRecordsPanel').style.display = 'none';
}

function showRoomInfo(entityId) {
    const bed = entities.find(e => e.entity_id === entityId);
    if (!bed) return;
    const name = bed.attributes?.friendly_name || bed.entity_id;
    const { isActive, isAlert, minutesAgo, lastTime } = getRoomStatus(bed);
    const statusText = isAlert ? '需要關注' : (isActive ? '有活動' : '靜止中');
    const timeStr = minutesAgo < 1 ? '剛剛' :
                    minutesAgo < 60 ? `${minutesAgo} 分鐘前` :
                    minutesAgo < 1440 ? `${Math.floor(minutesAgo/60)} 小時前` :
                    `${Math.floor(minutesAgo/1440)} 天前`;

    const content = document.getElementById('infoModalContent');
    content.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:12px;">
            <div class="room-info-row"><span class="room-info-label">房間名稱</span><span class="room-info-value">${escapeHtml(name)}</span></div>
            <div class="room-info-row"><span class="room-info-label">住民姓名</span><span class="room-info-value">${escapeHtml(bed.attributes?.resident_name || '--')}</span></div>
            <div class="room-info-row"><span class="room-info-label">年齡</span><span class="room-info-value">${bed.attributes?.age ? bed.attributes.age + ' 歲' : '--'}</span></div>
            <div class="room-info-row"><span class="room-info-label">目前狀態</span><span class="room-info-value">${statusText}</span></div>
            <div class="room-info-row"><span class="room-info-label">設備 ID</span><span class="room-info-value">${escapeHtml(bed.entity_id)}</span></div>
            <div class="room-info-row"><span class="room-info-label">最後偵測</span><span class="room-info-value">${timeStr}（${lastTime.toLocaleTimeString('zh-TW', {hour:'2-digit', minute:'2-digit'})}）</span></div>
            <div class="room-info-row"><span class="room-info-label">最後更新</span><span class="room-info-value">${new Date(bed.last_updated).toLocaleString('zh-TW')}</span></div>
            <div class="room-info-row"><span class="room-info-label">主治醫師</span><span class="room-info-value">${escapeHtml(bed.attributes?.doctor || '--')}</span></div>
            <div class="room-info-row"><span class="room-info-label">主護護理師</span><span class="room-info-value">${escapeHtml(bed.attributes?.nurse || '--')}</span></div>
            <div class="room-info-row"><span class="room-info-label">護理長</span><span class="room-info-value">${escapeHtml(bed.attributes?.supervisor || '--')}</span></div>
            <div class="room-info-row"><span class="room-info-label">備註</span><span class="room-info-value">${escapeHtml(bed.attributes?.note || '--')}</span></div>
        </div>
    `;
    document.getElementById('infoModal').classList.add('active');
}

function closeInfoModal() {
    document.getElementById('infoModal').classList.remove('active');
}

function showVitalSigns() {
    showToast('生命徵象', '此功能尚在開發中', 'info');
}

function showMedInfo() {
    showToast('用藥資訊', '此功能尚在開發中', 'info');
}

function showCareNotes() {
    showToast('護理紀錄', '此功能尚在開發中', 'info');
}

// ====== 編輯房間資料 ======

function openEditModal(entityId) {
    const bed = entities.find(e => e.entity_id === entityId);
    if (!bed) return;

    document.getElementById('editName').value = bed.attributes?.resident_name || '';
    document.getElementById('editAge').value = bed.attributes?.age || '';
    document.getElementById('editDoctor').value = bed.attributes?.doctor || '';
    document.getElementById('editNurse').value = bed.attributes?.nurse || '';
    document.getElementById('editSupervisor').value = bed.attributes?.supervisor || '';
    document.getElementById('editNote').value = bed.attributes?.note || '';

    document.getElementById('editModal').classList.add('active');
    document.getElementById('editModal').dataset.entityId = entityId;
}

function closeEditModal() {
    document.getElementById('editModal').classList.remove('active');
}

async function saveRoomEdit() {
    const entityId = document.getElementById('editModal').dataset.entityId;
    const residentName = document.getElementById('editName').value.trim();
    const age = document.getElementById('editAge').value.trim();
    const doctor = document.getElementById('editDoctor').value.trim();
    const nurse = document.getElementById('editNurse').value.trim();
    const supervisor = document.getElementById('editSupervisor').value.trim();
    const note = document.getElementById('editNote').value.trim();

    try {
        const bed = entities.find(e => e.entity_id === entityId);
        if (!bed) return;

        const attrs = { ...bed.attributes };
        if (residentName) attrs.resident_name = residentName;
        else delete attrs.resident_name;
        if (age) attrs.age = parseInt(age);
        else delete attrs.age;
        if (doctor) attrs.doctor = doctor;
        else delete attrs.doctor;
        if (nurse) attrs.nurse = nurse;
        else delete attrs.nurse;
        if (supervisor) attrs.supervisor = supervisor;
        else delete attrs.supervisor;
        if (note) attrs.note = note;
        else delete attrs.note;

        const res = await fetch(`${API_BASE}/api/entities/${entityId}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${AUTH}` },
            body: JSON.stringify({ state: bed.state, attributes: attrs })
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP ${res.status}`);
        }

        closeEditModal();
        await refreshEntities();

        if (currentRoomId === entityId) {
            const updated = entities.find(e => e.entity_id === entityId);
            if (updated) renderRoomDetail(updated);
        }

        showToast('儲存成功', '房間資料已更新', 'success');
    } catch (e) {
        console.error('saveRoomEdit error:', e);
        showToast('儲存失敗', e.message, 'error');
    }
}

// ====== 關閉警報（先填寫狀況） ======

function dismissAlert(entityId) {
    document.getElementById('dismissCondition').value = '';
    document.getElementById('dismissNote').value = '';
    document.getElementById('dismissHandler').value = '';
    document.getElementById('dismissModal').classList.add('active');
    document.getElementById('dismissModal').dataset.entityId = entityId;
}

function closeDismissModal() {
    document.getElementById('dismissModal').classList.remove('active');
}

async function confirmDismiss() {
    const entityId = document.getElementById('dismissModal').dataset.entityId;
    const condition = document.getElementById('dismissCondition').value.trim();
    const note = document.getElementById('dismissNote').value.trim();
    const handler = document.getElementById('dismissHandler').value.trim();

    if (!condition) {
        showToast('請填寫狀況', '必須填寫病人狀況才能關閉警報', 'error');
        return;
    }

    try {
        const bed = entities.find(e => e.entity_id === entityId);
        if (!bed) return;

        // 1. 先新增照護紀錄
        const recRes = await fetch(`${API_BASE}/api/care-records/${entityId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${AUTH}` },
            body: JSON.stringify({ condition, note, handler })
        });

        if (!recRes.ok) {
            const errData = await recRes.json().catch(() => ({}));
            throw new Error(errData.error || `紀錄失敗 HTTP ${recRes.status}`);
        }

        // 2. 再將房間設為正常
        const updRes = await fetch(`${API_BASE}/api/entities/${entityId}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${AUTH}` },
            body: JSON.stringify({ state: 'on', attributes: bed.attributes })
        });

        if (!updRes.ok) {
            throw new Error('更新房間狀態失敗');
        }

        closeDismissModal();
        await refreshEntities();

        if (currentRoomId === entityId) {
            const updated = entities.find(e => e.entity_id === entityId);
            if (updated) renderRoomDetail(updated);
        }

        showToast('已處理', `${bed.attributes?.friendly_name || entityId} 已記錄並恢復正常`, 'success');
    } catch (e) {
        console.error('confirmDismiss error:', e);
        showToast('操作失敗', e.message, 'error');
    }
}

// ====== 過往紀錄 ======

async function loadCareRecords(entityId) {
    try {
        const res = await fetch(`${API_BASE}/api/care-records/${entityId}`);
        if (!res.ok) return [];
        return await res.json();
    } catch (e) {
        return [];
    }
}

async function renderCareRecords(entityId, container) {
    const records = await loadCareRecords(entityId);

    if (records.length === 0) {
        container.innerHTML = '<div class="care-records-empty">暫無過往紀錄</div>';
        return;
    }

    container.innerHTML = records.map(r => {
        const t = new Date(r.timestamp);
        const timeStr = t.toLocaleString('zh-TW', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' });
        return `
            <div class="care-record-item">
                <div class="care-record-time">${timeStr}</div>
                <div class="care-record-condition">${escapeHtml(r.condition)}</div>
                ${r.note ? `<div class="care-record-note">備註：${escapeHtml(r.note)}</div>` : ''}
                ${r.handler ? `<div class="care-record-handler">處理人員：${escapeHtml(r.handler)}</div>` : ''}
            </div>
        `;
    }).join('');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ====== 渲染：環境監測 ======

function renderEnv() {
    const grid = document.getElementById('envGrid');
    if (!grid) return;
    const sensors = entities.filter(e => e.entity_id.startsWith('sensor.'));

    const envConfig = {
        'sensor.temperature': {
            icon: '',
            label: '病房溫度',
            unit: '°C',
            good: [22, 26],
            warn: [18, 30]
        },
        'sensor.humidity': {
            icon: '',
            label: '病房濕度',
            unit: '%',
            good: [40, 60],
            warn: [30, 70]
        },
        'sensor.pressure': {
            icon: '',
            label: '大氣壓力',
            unit: 'hPa',
            good: [1000, 1030],
            warn: [980, 1050]
        },
        'sensor.light': {
            icon: '',
            label: '環境光線',
            unit: 'lux',
            good: [100, 500],
            warn: [50, 800]
        }
    };

    grid.innerHTML = sensors.map(sensor => {
        const cfg = envConfig[sensor.entity_id] || {
            icon: '',
            label: sensor.attributes?.friendly_name || sensor.entity_id,
            unit: sensor.attributes?.unit_of_measurement || '',
            good: [-Infinity, Infinity],
            warn: [-Infinity, Infinity]
        };
        const val = parseFloat(sensor.state);
        let statusClass = 'good';
        let statusLabel = '正常';
        if (val < cfg.good[0] || val > cfg.good[1]) {
            statusClass = 'warn';
            statusLabel = '留意';
        }
        if (val < cfg.warn[0] || val > cfg.warn[1]) {
            statusClass = 'bad';
            statusLabel = '異常';
        }

        return `
            <div class="env-card">
                <div class="env-icon">${cfg.icon}</div>
                <div class="env-value">${sensor.state}<span class="env-unit"> ${cfg.unit}</span></div>
                <div class="env-label">${cfg.label}</div>
                <span class="env-status ${statusClass}">${statusLabel}</span>
            </div>
        `;
    }).join('');
}

// ====== 渲染：摘要數字 ======

function updateSummary() {
    const rooms = getFloorRooms(currentFloor);
    const active = rooms.filter(e => e.state === 'on');
    const inactive = rooms.filter(e => e.state === 'off');
    const alerts = inactive.filter(e => {
        const mins = (Date.now() - new Date(e.last_changed).getTime()) / 60000;
        return mins > 60;
    });
    const disconnected = rooms.filter(e => e.attributes?.device_connected === false);

    document.getElementById('sumTotal').textContent = rooms.length;
    document.getElementById('sumActive').textContent = active.length;
    document.getElementById('sumInactive').textContent = inactive.length;
    document.getElementById('sumAlert').textContent = alerts.length;
    document.getElementById('sumDisconnected').textContent = disconnected.length;
}

// ====== 渲染：系統資訊 ======

function renderSystemInfo(data) {
    const grid = document.getElementById('sysGrid');
    if (!grid) return;
    const memPct = parseFloat(data.memory?.percentage || 0);

    function fmtUptime(sec) {
        if (!sec) return '--';
        const d = Math.floor(sec / 86400);
        const h = Math.floor((sec % 86400) / 3600);
        const m = Math.floor((sec % 3600) / 60);
        return `${d} 天 ${h} 時 ${m} 分`;
    }

    grid.innerHTML = `
        <div class="sys-card">
            <h3>伺服器資訊</h3>
            <div class="sys-row"><span class="sys-label">主機名稱</span><span class="sys-value">${data.hostname || '--'}</span></div>
            <div class="sys-row"><span class="sys-label">作業系統</span><span class="sys-value">${data.platform || '--'}</span></div>
            <div class="sys-row"><span class="sys-label">CPU 核心</span><span class="sys-value">${data.cpus || '--'}</span></div>
            <div class="sys-row"><span class="sys-label">運行時間</span><span class="sys-value">${fmtUptime(data.uptime)}</span></div>
        </div>
        <div class="sys-card">
            <h3>資源使用</h3>
            <div class="sys-row"><span class="sys-label">記憶體使用率</span><span class="sys-value">${memPct.toFixed(1)}%</span></div>
            <div class="progress-bar"><div class="progress-fill" style="width:${memPct}%"></div></div>
            <div class="sys-row" style="margin-top:12px;"><span class="sys-label">監測中住民</span><span class="sys-value">${entities.filter(e=>e.entity_id.startsWith('switch.')).length} 位</span></div>
            <div class="sys-row"><span class="sys-label">感測器數量</span><span class="sys-value">${entities.filter(e=>e.entity_id.startsWith('sensor.')).length} 個</span></div>
        </div>
    `;
}

// ====== 事件紀錄 ======

function addLog(message, type) {
    type = type || 'info';
    const time = new Date().toLocaleTimeString('zh-TW', {hour:'2-digit', minute:'2-digit', second:'2-digit'});

    logEntries.unshift({ time, message, type });
    if (logEntries.length > 200) logEntries.length = 200;

    renderLogs();
}

function renderLogs() {
    const container = document.getElementById('logList');
    if (!container) return;
    if (logEntries.length === 0) {
        container.innerHTML = '<div class="log-item" style="color:var(--text-light);justify-content:center;">暫無紀錄</div>';
        return;
    }
    container.innerHTML = logEntries.map(entry => `
        <div class="log-item">
            <span class="log-dot ${entry.type}"></span>
            <span class="log-time">${entry.time}</span>
            <span>${entry.message}</span>
        </div>
    `).join('');
}

function clearLogs() {
    logEntries = [];
    renderLogs();
    addLog('紀錄已清除', 'info');
}

// ====== 通知 Toast ======

function showToast(title, message, type) {
    type = type || '';
    const container = document.getElementById('toastContainer');
    const div = document.createElement('div');
    div.className = 'toast' + (type ? ' ' + type : '');
    div.innerHTML = `<div class="toast-title">${title}</div><div>${message}</div>`;
    container.appendChild(div);
    setTimeout(() => {
        div.style.opacity = '0';
        div.style.transform = 'translateX(100%)';
        div.style.transition = 'all .3s';
        setTimeout(() => div.remove(), 300);
    }, 4000);
}

// ====== 分頁切換 ======

function switchTab(tabName, btn) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
    document.getElementById(tabName).classList.add('active');

    if (tabName === 'system') loadSystemInfo();
}

// ====== 定期刷新 ======

setInterval(() => { loadEntities(); }, 15000);
setInterval(() => { loadSystemInfo(); }, 60000);
