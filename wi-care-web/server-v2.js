const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const basicAuth = require('express-basic-auth');
const os = require('os');
const EventEmitter = require('events');

// 初始化 Express 應用
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 事件系統
const eventBus = new EventEmitter();

// 中介軟體配置
app.use(cors({ origin: '*', credentials: true }));
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// HTTP Basic Auth 認證
const authMiddleware = basicAuth({
  users: { 'admin': 'admin123' },
  challenge: true,
  realm: 'Wi-Care System'
});

// ==================== 數據存儲 ====================
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const AUTOMATIONS_FILE = path.join(DATA_DIR, 'automations.json');
const SCENES_FILE = path.join(DATA_DIR, 'scenes.json');
const ENTITIES_FILE = path.join(DATA_DIR, 'entities.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

// 確保數據目錄存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ==================== 實體管理系統 ====================
class EntityManager {
  constructor() {
    this.entities = new Map();
    this.loadEntities();
  }

  loadEntities() {
    try {
      if (fs.existsSync(ENTITIES_FILE)) {
        const data = JSON.parse(fs.readFileSync(ENTITIES_FILE, 'utf8'));
        data.forEach(entity => this.entities.set(entity.entity_id, entity));
      }
    } catch (error) {
      console.error('載入實體失敗:', error);
    }
  }

  saveEntities() {
    try {
      const data = Array.from(this.entities.values());
      fs.writeFileSync(ENTITIES_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('儲存實體失敗:', error);
    }
  }

  registerEntity(entity) {
    const now = new Date().toISOString();
    const fullEntity = {
      ...entity,
      last_changed: now,
      last_updated: now
    };
    this.entities.set(entity.entity_id, fullEntity);
    this.saveEntities();
    eventBus.emit('entity_registered', fullEntity);
    return fullEntity;
  }

  updateEntityState(entityId, state, attributes = {}) {
    const entity = this.entities.get(entityId);
    if (!entity) return null;

    const now = new Date().toISOString();
    const oldState = entity.state;
    
    entity.state = state;
    entity.attributes = { ...entity.attributes, ...attributes };
    entity.last_updated = now;
    
    if (oldState !== state) {
      entity.last_changed = now;
    }

    this.entities.set(entityId, entity);
    this.saveEntities();
    
    // 記錄歷史
    historyManager.addRecord(entityId, state, attributes);
    
    // 觸發事件
    eventBus.emit('state_changed', {
      entity_id: entityId,
      old_state: oldState,
      new_state: state,
      attributes
    });

    return entity;
  }

  getEntity(entityId) {
    return this.entities.get(entityId);
  }

  getAllEntities() {
    return Array.from(this.entities.values());
  }

  getEntitiesByDomain(domain) {
    return this.getAllEntities().filter(e => e.entity_id.startsWith(domain + '.'));
  }

  deleteEntity(entityId) {
    const deleted = this.entities.delete(entityId);
    if (deleted) {
      this.saveEntities();
      eventBus.emit('entity_deleted', entityId);
    }
    return deleted;
  }
}

// ==================== 歷史數據管理 ====================
class HistoryManager {
  constructor() {
    this.history = [];
    this.maxRecords = 10000;
    this.loadHistory();
  }

  loadHistory() {
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        this.history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      }
    } catch (error) {
      console.error('載入歷史失敗:', error);
    }
  }

  saveHistory() {
    try {
      // 只保留最新的記錄
      if (this.history.length > this.maxRecords) {
        this.history = this.history.slice(-this.maxRecords);
      }
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.history, null, 2));
    } catch (error) {
      console.error('儲存歷史失敗:', error);
    }
  }

  addRecord(entityId, state, attributes = {}) {
    const record = {
      entity_id: entityId,
      state: state,
      attributes: attributes,
      timestamp: new Date().toISOString()
    };
    this.history.push(record);
    
    // 定期儲存
    if (this.history.length % 100 === 0) {
      this.saveHistory();
    }
  }

  getHistory(entityId = null, startTime = null, endTime = null) {
    let filtered = this.history;

    if (entityId) {
      filtered = filtered.filter(r => r.entity_id === entityId);
    }

    if (startTime) {
      filtered = filtered.filter(r => new Date(r.timestamp) >= new Date(startTime));
    }

    if (endTime) {
      filtered = filtered.filter(r => new Date(r.timestamp) <= new Date(endTime));
    }

    return filtered;
  }

  clearHistory() {
    this.history = [];
    this.saveHistory();
  }
}

// ==================== 自動化規則引擎 ====================
class AutomationEngine {
  constructor() {
    this.automations = [];
    this.loadAutomations();
    this.setupEventListeners();
  }

  loadAutomations() {
    try {
      if (fs.existsSync(AUTOMATIONS_FILE)) {
        this.automations = JSON.parse(fs.readFileSync(AUTOMATIONS_FILE, 'utf8'));
      }
    } catch (error) {
      console.error('載入自動化失敗:', error);
    }
  }

  saveAutomations() {
    try {
      fs.writeFileSync(AUTOMATIONS_FILE, JSON.stringify(this.automations, null, 2));
    } catch (error) {
      console.error('儲存自動化失敗:', error);
    }
  }

  setupEventListeners() {
    // 監聽狀態變化
    eventBus.on('state_changed', (data) => {
      this.checkTriggers('state', data);
    });

    // 監聽時間觸發
    setInterval(() => {
      this.checkTriggers('time', { time: new Date() });
    }, 60000); // 每分鐘檢查一次
  }

  addAutomation(automation) {
    const newAutomation = {
      id: `automation_${Date.now()}`,
      enabled: true,
      last_triggered: null,
      ...automation
    };
    this.automations.push(newAutomation);
    this.saveAutomations();
    return newAutomation;
  }

  updateAutomation(id, updates) {
    const index = this.automations.findIndex(a => a.id === id);
    if (index === -1) return null;
    
    this.automations[index] = { ...this.automations[index], ...updates };
    this.saveAutomations();
    return this.automations[index];
  }

  deleteAutomation(id) {
    const index = this.automations.findIndex(a => a.id === id);
    if (index === -1) return false;
    
    this.automations.splice(index, 1);
    this.saveAutomations();
    return true;
  }

  checkTriggers(triggerType, data) {
    this.automations.forEach(automation => {
      if (!automation.enabled) return;

      automation.triggers.forEach(trigger => {
        if (trigger.platform !== triggerType) return;

        let shouldTrigger = false;

        switch (triggerType) {
          case 'state':
            if (trigger.entity_id === data.entity_id) {
              if (trigger.to && trigger.to === data.new_state) {
                shouldTrigger = true;
              } else if (trigger.from && trigger.from === data.old_state) {
                shouldTrigger = true;
              } else if (!trigger.to && !trigger.from) {
                shouldTrigger = true;
              }
            }
            break;

          case 'time':
            if (trigger.at) {
              const now = new Date();
              const triggerTime = new Date(trigger.at);
              if (now.getHours() === triggerTime.getHours() && 
                  now.getMinutes() === triggerTime.getMinutes()) {
                shouldTrigger = true;
              }
            }
            break;
        }

        if (shouldTrigger && this.checkConditions(automation.conditions || [])) {
          this.executeActions(automation.actions);
          automation.last_triggered = new Date().toISOString();
          this.saveAutomations();
          eventBus.emit('automation_triggered', automation);
        }
      });
    });
  }

  checkConditions(conditions) {
    if (conditions.length === 0) return true;

    return conditions.every(condition => {
      const entity = entityManager.getEntity(condition.entity_id);
      if (!entity) return false;

      switch (condition.condition) {
        case 'state':
          return entity.state === condition.state;
        case 'numeric_state':
          const value = parseFloat(entity.state);
          if (condition.above && value <= condition.above) return false;
          if (condition.below && value >= condition.below) return false;
          return true;
        case 'time':
          const now = new Date();
          if (condition.after) {
            const after = new Date(condition.after);
            if (now < after) return false;
          }
          if (condition.before) {
            const before = new Date(condition.before);
            if (now > before) return false;
          }
          return true;
        default:
          return true;
      }
    });
  }

  executeActions(actions) {
    actions.forEach(action => {
      switch (action.service) {
        case 'turn_on':
        case 'turn_off':
          const state = action.service === 'turn_on';
          entityManager.updateEntityState(action.entity_id, state ? 'on' : 'off');
          break;

        case 'toggle':
          const entity = entityManager.getEntity(action.entity_id);
          if (entity) {
            const newState = entity.state === 'on' ? 'off' : 'on';
            entityManager.updateEntityState(action.entity_id, newState);
          }
          break;

        case 'set_value':
          entityManager.updateEntityState(action.entity_id, action.value, action.attributes);
          break;

        case 'notify':
          console.log(`通知: ${action.message}`);
          broadcastToClients({
            type: 'notification',
            message: action.message,
            title: action.title || '系統通知'
          });
          break;

        case 'scene.activate':
          sceneManager.activateScene(action.scene_id);
          break;
      }
    });
  }

  getAllAutomations() {
    return this.automations;
  }
}

// ==================== 場景管理 ====================
class SceneManager {
  constructor() {
    this.scenes = [];
    this.loadScenes();
  }

  loadScenes() {
    try {
      if (fs.existsSync(SCENES_FILE)) {
        this.scenes = JSON.parse(fs.readFileSync(SCENES_FILE, 'utf8'));
      }
    } catch (error) {
      console.error('載入場景失敗:', error);
    }
  }

  saveScenes() {
    try {
      fs.writeFileSync(SCENES_FILE, JSON.stringify(this.scenes, null, 2));
    } catch (error) {
      console.error('儲存場景失敗:', error);
    }
  }

  addScene(scene) {
    const newScene = {
      id: `scene_${Date.now()}`,
      ...scene,
      created_at: new Date().toISOString()
    };
    this.scenes.push(newScene);
    this.saveScenes();
    return newScene;
  }

  updateScene(id, updates) {
    const index = this.scenes.findIndex(s => s.id === id);
    if (index === -1) return null;
    
    this.scenes[index] = { ...this.scenes[index], ...updates };
    this.saveScenes();
    return this.scenes[index];
  }

  deleteScene(id) {
    const index = this.scenes.findIndex(s => s.id === id);
    if (index === -1) return false;
    
    this.scenes.splice(index, 1);
    this.saveScenes();
    return true;
  }

  activateScene(id) {
    const scene = this.scenes.find(s => s.id === id);
    if (!scene) return false;

    scene.entities.forEach(entity => {
      entityManager.updateEntityState(entity.entity_id, entity.state, entity.attributes);
    });

    broadcastToClients({
      type: 'scene_activated',
      scene_id: id,
      scene_name: scene.name
    });

    return true;
  }

  getAllScenes() {
    return this.scenes;
  }
}

// ==================== 通知系統 ====================
class NotificationManager {
  constructor() {
    this.notifications = [];
    this.persistentNotifications = [];
    this.loadNotifications();
  }

  loadNotifications() {
    const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json');
    try {
      if (fs.existsSync(NOTIFICATIONS_FILE)) {
        const data = JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf8'));
        this.persistentNotifications = data.persistent || [];
      }
    } catch (error) {
      console.error('載入通知失敗:', error);
    }
  }

  saveNotifications() {
    const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json');
    try {
      fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify({
        persistent: this.persistentNotifications
      }, null, 2));
    } catch (error) {
      console.error('儲存通知失敗:', error);
    }
  }

  createNotification(title, message, options = {}) {
    const notification = {
      id: `notification_${Date.now()}`,
      title,
      message,
      timestamp: new Date().toISOString(),
      level: options.level || 'info', // info, warning, error, success
      persistent: options.persistent || false,
      dismissible: options.dismissible !== false,
      ...options
    };

    if (notification.persistent) {
      this.persistentNotifications.push(notification);
      this.saveNotifications();
    } else {
      this.notifications.push(notification);
      // 非持久化通知 1 小時後自動刪除
      setTimeout(() => {
        this.notifications = this.notifications.filter(n => n.id !== notification.id);
      }, 3600000);
    }

    // 廣播通知
    broadcastToClients({
      type: 'notification',
      notification
    });

    return notification;
  }

  dismissNotification(id) {
    this.notifications = this.notifications.filter(n => n.id !== id);
    this.persistentNotifications = this.persistentNotifications.filter(n => n.id !== id);
    this.saveNotifications();
  }

  getAllNotifications() {
    return [...this.persistentNotifications, ...this.notifications];
  }
}

// ==================== 群組管理 ====================
class GroupManager {
  constructor() {
    this.groups = [];
    this.loadGroups();
  }

  loadGroups() {
    const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
    try {
      if (fs.existsSync(GROUPS_FILE)) {
        this.groups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
      }
    } catch (error) {
      console.error('載入群組失敗:', error);
    }
  }

  saveGroups() {
    const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
    try {
      fs.writeFileSync(GROUPS_FILE, JSON.stringify(this.groups, null, 2));
    } catch (error) {
      console.error('儲存群組失敗:', error);
    }
  }

  createGroup(name, entityIds, options = {}) {
    const group = {
      id: `group_${Date.now()}`,
      name,
      entity_ids: entityIds,
      icon: options.icon || 'mdi:group',
      area: options.area || null,
      ...options
    };

    this.groups.push(group);
    this.saveGroups();
    return group;
  }

  updateGroup(id, updates) {
    const index = this.groups.findIndex(g => g.id === id);
    if (index === -1) return null;

    this.groups[index] = { ...this.groups[index], ...updates };
    this.saveGroups();
    return this.groups[index];
  }

  deleteGroup(id) {
    this.groups = this.groups.filter(g => g.id !== id);
    this.saveGroups();
  }

  getGroup(id) {
    return this.groups.find(g => g.id === id);
  }

  getAllGroups() {
    return this.groups;
  }

  // 控制群組內所有實體
  controlGroup(id, service, data = {}) {
    const group = this.getGroup(id);
    if (!group) return false;

    const results = [];
    group.entity_ids.forEach(entityId => {
      const entity = entityManager.getEntity(entityId);
      if (entity) {
        const [domain, ] = entityId.split('.');
        if (service === 'turn_on') {
          entityManager.updateEntityState(entityId, 'on');
          results.push({ entity_id: entityId, success: true });
        } else if (service === 'turn_off') {
          entityManager.updateEntityState(entityId, 'off');
          results.push({ entity_id: entityId, success: true });
        } else if (service === 'toggle') {
          const newState = entity.state === 'on' ? 'off' : 'on';
          entityManager.updateEntityState(entityId, newState);
          results.push({ entity_id: entityId, success: true });
        }
      }
    });

    return results;
  }
}

// ==================== 輸入助手管理 ====================
class InputHelperManager {
  constructor() {
    this.helpers = new Map();
    this.loadHelpers();
  }

  loadHelpers() {
    const HELPERS_FILE = path.join(DATA_DIR, 'input_helpers.json');
    try {
      if (fs.existsSync(HELPERS_FILE)) {
        const data = JSON.parse(fs.readFileSync(HELPERS_FILE, 'utf8'));
        data.forEach(helper => this.helpers.set(helper.entity_id, helper));
      }
    } catch (error) {
      console.error('載入輸入助手失敗:', error);
    }
  }

  saveHelpers() {
    const HELPERS_FILE = path.join(DATA_DIR, 'input_helpers.json');
    try {
      fs.writeFileSync(HELPERS_FILE, JSON.stringify(Array.from(this.helpers.values()), null, 2));
    } catch (error) {
      console.error('儲存輸入助手失敗:', error);
    }
  }

  // 創建 input_boolean
  createInputBoolean(name, options = {}) {
    const entity_id = `input_boolean.${name.toLowerCase().replace(/\s+/g, '_')}`;
    const helper = {
      entity_id,
      type: 'input_boolean',
      name: options.friendly_name || name,
      state: options.initial || 'off',
      icon: options.icon || 'mdi:toggle-switch'
    };

    this.helpers.set(entity_id, helper);
    entityManager.registerEntity({
      entity_id,
      state: helper.state,
      attributes: { friendly_name: helper.name, icon: helper.icon }
    });
    this.saveHelpers();
    return helper;
  }

  // 創建 input_number
  createInputNumber(name, options = {}) {
    const entity_id = `input_number.${name.toLowerCase().replace(/\s+/g, '_')}`;
    const helper = {
      entity_id,
      type: 'input_number',
      name: options.friendly_name || name,
      state: options.initial || options.min || 0,
      min: options.min || 0,
      max: options.max || 100,
      step: options.step || 1,
      unit: options.unit || '',
      icon: options.icon || 'mdi:numeric'
    };

    this.helpers.set(entity_id, helper);
    entityManager.registerEntity({
      entity_id,
      state: helper.state.toString(),
      attributes: { 
        friendly_name: helper.name, 
        icon: helper.icon,
        min: helper.min,
        max: helper.max,
        step: helper.step,
        unit_of_measurement: helper.unit
      }
    });
    this.saveHelpers();
    return helper;
  }

  // 創建 input_select
  createInputSelect(name, options = {}) {
    const entity_id = `input_select.${name.toLowerCase().replace(/\s+/g, '_')}`;
    const helper = {
      entity_id,
      type: 'input_select',
      name: options.friendly_name || name,
      state: options.initial || (options.options && options.options[0]) || '',
      options: options.options || [],
      icon: options.icon || 'mdi:format-list-bulleted'
    };

    this.helpers.set(entity_id, helper);
    entityManager.registerEntity({
      entity_id,
      state: helper.state,
      attributes: { 
        friendly_name: helper.name, 
        icon: helper.icon,
        options: helper.options
      }
    });
    this.saveHelpers();
    return helper;
  }

  // 創建 input_text
  createInputText(name, options = {}) {
    const entity_id = `input_text.${name.toLowerCase().replace(/\s+/g, '_')}`;
    const helper = {
      entity_id,
      type: 'input_text',
      name: options.friendly_name || name,
      state: options.initial || '',
      min_length: options.min || 0,
      max_length: options.max || 255,
      pattern: options.pattern || null,
      icon: options.icon || 'mdi:text'
    };

    this.helpers.set(entity_id, helper);
    entityManager.registerEntity({
      entity_id,
      state: helper.state,
      attributes: { 
        friendly_name: helper.name, 
        icon: helper.icon
      }
    });
    this.saveHelpers();
    return helper;
  }

  updateHelper(entity_id, value) {
    const helper = this.helpers.get(entity_id);
    if (!helper) return false;

    helper.state = value;
    entityManager.updateEntityState(entity_id, value.toString());
    this.saveHelpers();
    return true;
  }

  deleteHelper(entity_id) {
    this.helpers.delete(entity_id);
    this.saveHelpers();
  }

  getAllHelpers() {
    return Array.from(this.helpers.values());
  }
}

// ==================== 腳本管理 ====================
class ScriptManager {
  constructor() {
    this.scripts = [];
    this.loadScripts();
  }

  loadScripts() {
    const SCRIPTS_FILE = path.join(DATA_DIR, 'scripts.json');
    try {
      if (fs.existsSync(SCRIPTS_FILE)) {
        this.scripts = JSON.parse(fs.readFileSync(SCRIPTS_FILE, 'utf8'));
      }
    } catch (error) {
      console.error('載入腳本失敗:', error);
    }
  }

  saveScripts() {
    const SCRIPTS_FILE = path.join(DATA_DIR, 'scripts.json');
    try {
      fs.writeFileSync(SCRIPTS_FILE, JSON.stringify(this.scripts, null, 2));
    } catch (error) {
      console.error('儲存腳本失敗:', error);
    }
  }

  createScript(name, sequence, options = {}) {
    const script = {
      id: `script_${Date.now()}`,
      name,
      sequence, // 動作數組
      description: options.description || '',
      icon: options.icon || 'mdi:script-text',
      last_triggered: null
    };

    this.scripts.push(script);
    this.saveScripts();
    return script;
  }

  async executeScript(id, variables = {}) {
    const script = this.scripts.find(s => s.id === id);
    if (!script) return false;

    // 更新最後執行時間
    script.last_triggered = new Date().toISOString();
    this.saveScripts();

    // 執行動作序列
    for (const action of script.sequence) {
      try {
        if (action.delay) {
          // 延遲執行
          await new Promise(resolve => setTimeout(resolve, action.delay));
        } else if (action.service) {
          // 執行服務調用
          const [domain, service] = action.service.split('.');
          if (domain === 'switch' || domain === 'light') {
            if (service === 'turn_on') {
              entityManager.updateEntityState(action.entity_id, 'on');
            } else if (service === 'turn_off') {
              entityManager.updateEntityState(action.entity_id, 'off');
            } else if (service === 'toggle') {
              const entity = entityManager.getEntity(action.entity_id);
              const newState = entity.state === 'on' ? 'off' : 'on';
              entityManager.updateEntityState(action.entity_id, newState);
            }
          } else if (domain === 'scene') {
            sceneManager.activateScene(action.entity_id.replace('scene.', 'scene_'));
          } else if (domain === 'script') {
            // 遞迴執行腳本
            const scriptId = action.entity_id.replace('script.', 'script_');
            await this.executeScript(scriptId);
          } else if (domain === 'notify') {
            notificationManager.createNotification(
              action.data?.title || '通知',
              action.data?.message || '',
              { level: 'info' }
            );
          }
        }
      } catch (error) {
        console.error(`執行腳本 ${id} 動作失敗:`, error);
      }
    }

    broadcastToClients({
      type: 'script_executed',
      script_id: id,
      script_name: script.name
    });

    return true;
  }

  deleteScript(id) {
    this.scripts = this.scripts.filter(s => s.id !== id);
    this.saveScripts();
  }

  getAllScripts() {
    return this.scripts;
  }
}

// ==================== 區域管理 ====================
class AreaManager {
  constructor() {
    this.areas = [];
    this.loadAreas();
  }

  loadAreas() {
    const AREAS_FILE = path.join(DATA_DIR, 'areas.json');
    try {
      if (fs.existsSync(AREAS_FILE)) {
        this.areas = JSON.parse(fs.readFileSync(AREAS_FILE, 'utf8'));
      }
    } catch (error) {
      console.error('載入區域失敗:', error);
    }
  }

  saveAreas() {
    const AREAS_FILE = path.join(DATA_DIR, 'areas.json');
    try {
      fs.writeFileSync(AREAS_FILE, JSON.stringify(this.areas, null, 2));
    } catch (error) {
      console.error('儲存區域失敗:', error);
    }
  }

  createArea(name, options = {}) {
    const area = {
      id: `area_${Date.now()}`,
      name,
      icon: options.icon || 'mdi:home',
      picture: options.picture || null,
      entity_ids: []
    };

    this.areas.push(area);
    this.saveAreas();
    return area;
  }

  updateArea(id, updates) {
    const index = this.areas.findIndex(a => a.id === id);
    if (index === -1) return null;

    this.areas[index] = { ...this.areas[index], ...updates };
    this.saveAreas();
    return this.areas[index];
  }

  deleteArea(id) {
    this.areas = this.areas.filter(a => a.id !== id);
    this.saveAreas();
  }

  assignEntityToArea(entityId, areaId) {
    const area = this.areas.find(a => a.id === areaId);
    if (!area) return false;

    // 從其他區域移除
    this.areas.forEach(a => {
      a.entity_ids = a.entity_ids.filter(id => id !== entityId);
    });

    // 添加到新區域
    if (!area.entity_ids.includes(entityId)) {
      area.entity_ids.push(entityId);
    }

    this.saveAreas();
    return true;
  }

  getEntitiesByArea(areaId) {
    const area = this.areas.find(a => a.id === areaId);
    if (!area) return [];

    return area.entity_ids.map(id => entityManager.getEntity(id)).filter(e => e);
  }

  getAllAreas() {
    return this.areas;
  }
}

// ==================== 初始化管理器 ====================
const entityManager = new EntityManager();
const historyManager = new HistoryManager();
const automationEngine = new AutomationEngine();
const sceneManager = new SceneManager();
const notificationManager = new NotificationManager();
const groupManager = new GroupManager();
const inputHelperManager = new InputHelperManager();
const scriptManager = new ScriptManager();
const areaManager = new AreaManager();

// 初始化 GPIO 實體
const GPIO_PINS = [2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27];
GPIO_PINS.forEach(pin => {
  if (!entityManager.getEntity(`switch.gpio_${pin}`)) {
    entityManager.registerEntity({
      entity_id: `switch.gpio_${pin}`,
      state: 'off',
      attributes: {
        friendly_name: `GPIO ${pin}`,
        icon: 'mdi:electric-switch',
        device_class: 'switch'
      }
    });
  }
});

// 初始化感測器實體
const sensors = [
  { id: 'temperature', name: '溫度', unit: '°C', icon: 'mdi:thermometer' },
  { id: 'humidity', name: '濕度', unit: '%', icon: 'mdi:water-percent' },
  { id: 'pressure', name: '氣壓', unit: 'hPa', icon: 'mdi:gauge' },
  { id: 'light', name: '光線', unit: 'lux', icon: 'mdi:brightness-6' },
];

sensors.forEach(sensor => {
  if (!entityManager.getEntity(`sensor.${sensor.id}`)) {
    entityManager.registerEntity({
      entity_id: `sensor.${sensor.id}`,
      state: '0',
      attributes: {
        friendly_name: sensor.name,
        unit_of_measurement: sensor.unit,
        icon: sensor.icon,
        device_class: 'measurement'
      }
    });
  }
});

// ==================== RESTful API 端點 ====================

// 系統狀態
app.get('/api/status', (req, res) => {
  res.json({
    entities: entityManager.getAllEntities(),
    automations: automationEngine.getAllAutomations(),
    scenes: sceneManager.getAllScenes(),
    systemInfo: getSystemInfo(),
    timestamp: new Date().toISOString()
  });
});

// ==================== 實體 API ====================

app.get('/api/entities', (req, res) => {
  const domain = req.query.domain;
  if (domain) {
    res.json(entityManager.getEntitiesByDomain(domain));
  } else {
    res.json(entityManager.getAllEntities());
  }
});

app.get('/api/entities/:entity_id', (req, res) => {
  const entity = entityManager.getEntity(req.params.entity_id);
  if (entity) {
    res.json(entity);
  } else {
    res.status(404).json({ error: '實體不存在' });
  }
});

app.post('/api/entities', authMiddleware, (req, res) => {
  try {
    const entity = entityManager.registerEntity(req.body);
    res.json({ success: true, entity });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/entities/:entity_id/update', authMiddleware, (req, res) => {
  const { state, attributes } = req.body;
  const entity = entityManager.updateEntityState(req.params.entity_id, state, attributes);
  
  if (entity) {
    res.json({ success: true, entity });
  } else {
    res.status(404).json({ error: '實體不存在' });
  }
});

app.delete('/api/entities/:entity_id', authMiddleware, (req, res) => {
  const deleted = entityManager.deleteEntity(req.params.entity_id);
  res.json({ success: deleted });
});

// ==================== 服務調用 API ====================

app.post('/api/services/:domain/:service', authMiddleware, (req, res) => {
  const { domain, service } = req.params;
  const { entity_id, data } = req.body;

  try {
    switch (`${domain}.${service}`) {
      case 'switch.turn_on':
      case 'light.turn_on':
        entityManager.updateEntityState(entity_id, 'on', data);
        break;

      case 'switch.turn_off':
      case 'light.turn_off':
        entityManager.updateEntityState(entity_id, 'off', data);
        break;

      case 'switch.toggle':
      case 'light.toggle':
        const entity = entityManager.getEntity(entity_id);
        if (entity) {
          const newState = entity.state === 'on' ? 'off' : 'on';
          entityManager.updateEntityState(entity_id, newState, data);
        }
        break;

      case 'scene.activate':
        sceneManager.activateScene(entity_id);
        break;

      default:
        res.status(400).json({ error: '不支援的服務' });
        return;
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== 自動化 API ====================

app.get('/api/automations', (req, res) => {
  res.json(automationEngine.getAllAutomations());
});

app.post('/api/automations', authMiddleware, (req, res) => {
  const automation = automationEngine.addAutomation(req.body);
  res.json({ success: true, automation });
});

app.put('/api/automations/:id', authMiddleware, (req, res) => {
  const automation = automationEngine.updateAutomation(req.params.id, req.body);
  if (automation) {
    res.json({ success: true, automation });
  } else {
    res.status(404).json({ error: '自動化不存在' });
  }
});

app.delete('/api/automations/:id', authMiddleware, (req, res) => {
  const deleted = automationEngine.deleteAutomation(req.params.id);
  res.json({ success: deleted });
});

app.post('/api/automations/:id/toggle', authMiddleware, (req, res) => {
  const automation = automationEngine.automations.find(a => a.id === req.params.id);
  if (automation) {
    automation.enabled = !automation.enabled;
    automationEngine.saveAutomations();
    res.json({ success: true, enabled: automation.enabled });
  } else {
    res.status(404).json({ error: '自動化不存在' });
  }
});

// ==================== 場景 API ====================

app.get('/api/scenes', (req, res) => {
  res.json(sceneManager.getAllScenes());
});

app.post('/api/scenes', authMiddleware, (req, res) => {
  const scene = sceneManager.addScene(req.body);
  res.json({ success: true, scene });
});

app.put('/api/scenes/:id', authMiddleware, (req, res) => {
  const scene = sceneManager.updateScene(req.params.id, req.body);
  if (scene) {
    res.json({ success: true, scene });
  } else {
    res.status(404).json({ error: '場景不存在' });
  }
});

app.delete('/api/scenes/:id', authMiddleware, (req, res) => {
  const deleted = sceneManager.deleteScene(req.params.id);
  res.json({ success: deleted });
});

app.post('/api/scenes/:id/activate', authMiddleware, (req, res) => {
  const activated = sceneManager.activateScene(req.params.id);
  res.json({ success: activated });
});

// ==================== 歷史 API ====================

app.get('/api/history', (req, res) => {
  const { entity_id, start_time, end_time } = req.query;
  const history = historyManager.getHistory(entity_id, start_time, end_time);
  res.json(history);
});

app.delete('/api/history', authMiddleware, (req, res) => {
  historyManager.clearHistory();
  res.json({ success: true });
});

// ==================== 通知 API ====================

app.get('/api/notifications', (req, res) => {
  res.json(notificationManager.getAllNotifications());
});

app.post('/api/notifications', authMiddleware, (req, res) => {
  const { title, message, ...options } = req.body;
  const notification = notificationManager.createNotification(title, message, options);
  res.json({ success: true, notification });
});

app.delete('/api/notifications/:id', authMiddleware, (req, res) => {
  notificationManager.dismissNotification(req.params.id);
  res.json({ success: true });
});

// ==================== 群組 API ====================

app.get('/api/groups', (req, res) => {
  res.json(groupManager.getAllGroups());
});

app.get('/api/groups/:id', (req, res) => {
  const group = groupManager.getGroup(req.params.id);
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }
  res.json(group);
});

app.post('/api/groups', authMiddleware, (req, res) => {
  const { name, entity_ids, ...options } = req.body;
  const group = groupManager.createGroup(name, entity_ids, options);
  res.json({ success: true, group });
});

app.put('/api/groups/:id', authMiddleware, (req, res) => {
  const group = groupManager.updateGroup(req.params.id, req.body);
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }
  res.json({ success: true, group });
});

app.delete('/api/groups/:id', authMiddleware, (req, res) => {
  groupManager.deleteGroup(req.params.id);
  res.json({ success: true });
});

app.post('/api/groups/:id/:service', authMiddleware, (req, res) => {
  const results = groupManager.controlGroup(req.params.id, req.params.service, req.body);
  res.json({ success: true, results });
});

// ==================== 輸入助手 API ====================

app.get('/api/input_helpers', (req, res) => {
  res.json(inputHelperManager.getAllHelpers());
});

app.post('/api/input_helpers/boolean', authMiddleware, (req, res) => {
  const { name, ...options } = req.body;
  const helper = inputHelperManager.createInputBoolean(name, options);
  res.json({ success: true, helper });
});

app.post('/api/input_helpers/number', authMiddleware, (req, res) => {
  const { name, ...options } = req.body;
  const helper = inputHelperManager.createInputNumber(name, options);
  res.json({ success: true, helper });
});

app.post('/api/input_helpers/select', authMiddleware, (req, res) => {
  const { name, ...options } = req.body;
  const helper = inputHelperManager.createInputSelect(name, options);
  res.json({ success: true, helper });
});

app.post('/api/input_helpers/text', authMiddleware, (req, res) => {
  const { name, ...options } = req.body;
  const helper = inputHelperManager.createInputText(name, options);
  res.json({ success: true, helper });
});

app.put('/api/input_helpers/:entity_id', authMiddleware, (req, res) => {
  const success = inputHelperManager.updateHelper(req.params.entity_id, req.body.value);
  if (!success) {
    return res.status(404).json({ error: 'Helper not found' });
  }
  res.json({ success: true });
});

app.delete('/api/input_helpers/:entity_id', authMiddleware, (req, res) => {
  inputHelperManager.deleteHelper(req.params.entity_id);
  res.json({ success: true });
});

// ==================== 腳本 API ====================

app.get('/api/scripts', (req, res) => {
  res.json(scriptManager.getAllScripts());
});

app.post('/api/scripts', authMiddleware, (req, res) => {
  const { name, sequence, ...options } = req.body;
  const script = scriptManager.createScript(name, sequence, options);
  res.json({ success: true, script });
});

app.post('/api/scripts/:id/execute', authMiddleware, async (req, res) => {
  const success = await scriptManager.executeScript(req.params.id, req.body.variables);
  if (!success) {
    return res.status(404).json({ error: 'Script not found' });
  }
  res.json({ success: true });
});

app.delete('/api/scripts/:id', authMiddleware, (req, res) => {
  scriptManager.deleteScript(req.params.id);
  res.json({ success: true });
});

// ==================== 區域 API ====================

app.get('/api/areas', (req, res) => {
  res.json(areaManager.getAllAreas());
});

app.post('/api/areas', authMiddleware, (req, res) => {
  const { name, ...options } = req.body;
  const area = areaManager.createArea(name, options);
  res.json({ success: true, area });
});

app.put('/api/areas/:id', authMiddleware, (req, res) => {
  const area = areaManager.updateArea(req.params.id, req.body);
  if (!area) {
    return res.status(404).json({ error: 'Area not found' });
  }
  res.json({ success: true, area });
});

app.delete('/api/areas/:id', authMiddleware, (req, res) => {
  areaManager.deleteArea(req.params.id);
  res.json({ success: true });
});

app.post('/api/areas/:areaId/assign/:entityId', authMiddleware, (req, res) => {
  const success = areaManager.assignEntityToArea(req.params.entityId, req.params.areaId);
  if (!success) {
    return res.status(404).json({ error: 'Area not found' });
  }
  res.json({ success: true });
});

app.get('/api/areas/:id/entities', (req, res) => {
  const entities = areaManager.getEntitiesByArea(req.params.id);
  res.json(entities);
});

// ==================== 系統 API ====================

app.get('/api/system', (req, res) => {
  res.json(getSystemInfo());
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);
  
  const interval = setInterval(() => {
    const data = {
      type: 'status',
      entities: entityManager.getAllEntities(),
      systemInfo: getSystemInfo(),
      timestamp: Date.now()
    };
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }, 3000);
  
  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

// ==================== WebSocket ====================

const clients = new Set();

wss.on('connection', (ws, req) => {
  console.log('WebSocket 客戶端已連接');
  clients.add(ws);
  
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Wi-Care System WebSocket 連接成功',
    timestamp: Date.now()
  }));
  
  ws.send(JSON.stringify({
    type: 'state',
    entities: entityManager.getAllEntities(),
    timestamp: Date.now()
  }));
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleWebSocketMessage(ws, data);
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  });
  
  ws.on('close', () => {
    console.log('WebSocket 客戶端已斷開');
    clients.delete(ws);
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket 錯誤:', error);
    clients.delete(ws);
  });
});

function handleWebSocketMessage(ws, data) {
  switch (data.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;
      
    case 'get_state':
      ws.send(JSON.stringify({ 
        type: 'state', 
        entities: entityManager.getAllEntities(),
        timestamp: Date.now()
      }));
      break;
      
    case 'call_service':
      const { domain, service, entity_id, data: serviceData } = data;
      
      switch (`${domain}.${service}`) {
        case 'switch.turn_on':
        case 'light.turn_on':
          entityManager.updateEntityState(entity_id, 'on', serviceData);
          break;
        case 'switch.turn_off':
        case 'light.turn_off':
          entityManager.updateEntityState(entity_id, 'off', serviceData);
          break;
        case 'switch.toggle':
        case 'light.toggle':
          const entity = entityManager.getEntity(entity_id);
          if (entity) {
            const newState = entity.state === 'on' ? 'off' : 'on';
            entityManager.updateEntityState(entity_id, newState, serviceData);
          }
          break;
      }
      break;
      
    default:
      ws.send(JSON.stringify({ type: 'error', message: '未知的消息類型' }));
  }
}

function broadcastToClients(data) {
  const message = JSON.stringify({ ...data, timestamp: Date.now() });
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// 監聽狀態變化並廣播
eventBus.on('state_changed', (data) => {
  broadcastToClients({
    type: 'state_changed',
    entity_id: data.entity_id,
    old_state: data.old_state,
    new_state: data.new_state,
    attributes: data.attributes
  });
});

// ==================== 系統監控 ====================

function getSystemInfo() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptime: os.uptime(),
    loadavg: os.loadavg(),
    memory: {
      total: totalMem,
      free: freeMem,
      used: usedMem,
      percentage: ((usedMem / totalMem) * 100).toFixed(2)
    },
    cpus: os.cpus().length,
    networkInterfaces: Object.keys(os.networkInterfaces()),
    timestamp: Date.now()
  };
}

// 模擬感測器數據更新
setInterval(() => {
  entityManager.updateEntityState('sensor.temperature', 
    (20 + Math.random() * 10).toFixed(2));
  entityManager.updateEntityState('sensor.humidity', 
    (40 + Math.random() * 30).toFixed(2));
  entityManager.updateEntityState('sensor.pressure', 
    (1000 + Math.random() * 50).toFixed(2));
  entityManager.updateEntityState('sensor.light', 
    Math.floor(Math.random() * 1024).toString());
}, 5000);

// 定期儲存歷史數據
setInterval(() => {
  historyManager.saveHistory();
}, 60000); // 每分鐘儲存一次

// ==================== 啟動服務器 ====================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║    Wi-Care Home Automation System v2.0        ║
╠════════════════════════════════════════════════╣
║  Web Server: http://localhost:${PORT}        ║
║  WebSocket:  ws://localhost:${PORT}          ║
║  SSE Events: http://localhost:${PORT}/api/events
║                                                ║
║  預設帳號: admin / admin123                   ║
╠════════════════════════════════════════════════╣
║  新功能:                                       ║
║  ✅ 實體管理系統                               ║
║  ✅ 自動化規則引擎                             ║
║  ✅ 場景管理                                   ║
║  ✅ 歷史數據記錄                               ║
║  ✅ 服務調用系統                               ║
║  ✅ 事件驅動架構                               ║
╚════════════════════════════════════════════════╝
  `);
  console.log('系統已啟動，正在監聽連接...\n');
  console.log(`已註冊 ${entityManager.getAllEntities().length} 個實體`);
});

// 優雅關閉
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM 信號，正在關閉服務器...');
  historyManager.saveHistory();
  server.close(() => {
    console.log('服務器已關閉');
    process.exit(0);
  });
});
