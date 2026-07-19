"""
WiFi CSI 手勢辨識 — LSTM 訓練腳本  v2
=======================================
資料來源：wi-care-web/gesture-lab/data/
類別：empty_room (0)、squat (1)、wave (2)
特徵：Raw Score + Smoothed Score + Delta Raw + Delta Smoothed + Abs Delta Raw + Raw-Smoothed（6 個）
修正：
  - 先分割原始錄製、再擴增訓練集（防資料洩漏）
  - 驗證集使用未擴增的原始錄製
    - 加入更多時間變化與差異特徵，讓 wave / empty_room 更容易分開
使用方式：
  python train_lstm.py           # 訓練並儲存模型
  python train_lstm.py --predict # 用第一筆 wave 測試推論
"""
import argparse
import json
import os
import pickle
import numpy as np
# ─────────────────────────────────────────────
#  設定區
# ─────────────────────────────────────────────
DATA_DIR       = os.path.join(os.path.dirname(__file__), "data")
MODEL_PATH     = os.path.join(os.path.dirname(__file__), "lstm_model.pth")
SCALER_PATH    = os.path.join(os.path.dirname(__file__), "scaler.pkl")
CLASSES        = ["empty_room", "squat", "wave"]
BASE_FEATURES  = ["Raw Score", "Smoothed Score"]
INPUT_SIZE     = 6          # Raw + Smoothed + Delta Raw + Delta Smoothed + Abs Delta Raw + Raw-Smoothed
SEQ_LEN        = 50
SLIDE_STEP     = 10         # 滑動視窗步長（訓練集用）
AUGMENT_TIMES  = 3          # 每個視窗的擴增份數（已有滑動視窗，不需太多）
HIDDEN_SIZE    = 64
NUM_LAYERS     = 2
DROPOUT        = 0.3
EPOCHS         = 200
BATCH_SIZE     = 16
LR             = 0.001
# ═══════════════════════════════════════════════
#  1. 資料載入
# ═══════════════════════════════════════════════
def extract_base_features(frame):
    if "Raw Score" in frame and "Smoothed Score" in frame:
        return [frame["Raw Score"], frame["Smoothed Score"]]

    if "deviceA" in frame and "deviceB" in frame:
        return [frame["deviceA"], frame["deviceB"]]

    raise KeyError(f"Unknown frame format: {list(frame.keys())}")


def load_raw_data():
    X_raw, y = [], []
    for label, cls in enumerate(CLASSES):
        path = os.path.join(DATA_DIR, f"{cls}.json")
        recordings = json.load(open(path, encoding="utf-8"))
        for rec in recordings:
            seq = [extract_base_features(frame) for frame in rec]
            X_raw.append(seq)
            y.append(label)
    print(f"[載入] {len(X_raw)} 筆原始錄製  "
          f"({CLASSES[0]}:{y.count(0)}, {CLASSES[1]}:{y.count(1)}, {CLASSES[2]}:{y.count(2)})")
    return X_raw, y
# ═══════════════════════════════════════════════
#  2. 特徵工程：加入時間差異與差值特徵
# ═══════════════════════════════════════════════
def add_delta(seq_2d):
    """(T,2) list/array → (T,6) ndarray；補強時間變化與兩通道差異特徵。"""
    arr   = np.array(seq_2d, dtype=np.float32)
    raw   = arr[:, 0:1]
    smooth = arr[:, 1:2]

    delta_raw = np.zeros((len(arr), 1), dtype=np.float32)
    delta_smooth = np.zeros((len(arr), 1), dtype=np.float32)
    if len(arr) > 1:
        delta_raw[1:, 0] = raw[1:, 0] - raw[:-1, 0]
        delta_smooth[1:, 0] = smooth[1:, 0] - smooth[:-1, 0]

    abs_delta_raw = np.abs(delta_raw)
    raw_minus_smooth = raw - smooth

    return np.hstack([arr, delta_raw, delta_smooth, abs_delta_raw, raw_minus_smooth])


class SimpleStandardScaler:
    def __init__(self):
        self.mean_ = None
        self.scale_ = None

    def fit(self, values):
        self.mean_ = values.mean(axis=0)
        scale = values.std(axis=0)
        scale[scale < 1e-6] = 1.0
        self.scale_ = scale
        return self

    def transform(self, values):
        return (values - self.mean_) / self.scale_


def stratified_split_indices(labels, test_size=0.25, random_state=42):
    rng = np.random.default_rng(random_state)
    by_label = {}
    for index, label in enumerate(labels):
        by_label.setdefault(label, []).append(index)

    train_indices = []
    val_indices = []
    for label in sorted(by_label):
        label_indices = np.array(by_label[label], dtype=np.int64)
        rng.shuffle(label_indices)
        val_count = max(1, int(round(len(label_indices) * test_size)))
        val_count = min(val_count, len(label_indices) - 1) if len(label_indices) > 1 else 1
        val_indices.extend(label_indices[:val_count].tolist())
        train_indices.extend(label_indices[val_count:].tolist())

    rng.shuffle(train_indices)
    rng.shuffle(val_indices)
    return train_indices, val_indices
# ═══════════════════════════════════════════════
#  3. 前處理
# ═══════════════════════════════════════════════
def fit_scaler(X_3d_list):
    all_frames = np.vstack(X_3d_list)
    scaler = SimpleStandardScaler()
    scaler.fit(all_frames)
    return scaler
def apply_scaler(X_3d_list, scaler):
    return [scaler.transform(x).astype(np.float32) for x in X_3d_list]
def pad_or_truncate(arr, max_len):
    if len(arr) >= max_len:
        return arr[:max_len]
    pad = np.zeros((max_len - len(arr), arr.shape[1]), dtype=np.float32)
    return np.vstack([arr, pad])

def sliding_windows(arr, seq_len, step):
    """從一筆錄製切出多個固定長度視窗（訓練集專用）"""
    windows = []
    for start in range(0, max(1, len(arr) - seq_len + 1), step):
        w = arr[start:start + seq_len]
        if len(w) == seq_len:
            windows.append(w)
    if not windows:  # 錄製比 seq_len 短，保留 pad 版本
        windows.append(pad_or_truncate(arr, seq_len))
    return windows
# ═══════════════════════════════════════════════
#  4. 資料擴增（只用於訓練集）
# ═══════════════════════════════════════════════
def augment_once(arr):
    s      = arr.copy()
    choice = np.random.randint(0, 4)
    if choice == 0:
        s += np.random.normal(0, 0.08, s.shape).astype(np.float32)
    elif choice == 1:
        s *= np.float32(np.random.uniform(0.80, 1.20))
    elif choice == 2:
        shift = np.random.randint(1, max(2, len(s) // 5))
        s     = np.roll(s, shift, axis=0)
    elif choice == 3:
        margin = max(1, len(s) // 5)
        start  = np.random.randint(0, margin)
        end    = len(s) - np.random.randint(0, margin)
        if end - start > 3:
            s = s[start:end]
    return s
def build_augmented(X_norm, y, times):
    X_out, y_out = [], []
    for arr, label in zip(X_norm, y):
        X_out.append(pad_or_truncate(arr, SEQ_LEN))
        y_out.append(label)
        for _ in range(times):
            aug = augment_once(arr)
            X_out.append(pad_or_truncate(aug, SEQ_LEN))
            y_out.append(label)
    return np.array(X_out, dtype=np.float32), np.array(y_out, dtype=np.int64)
# ═══════════════════════════════════════════════
#  5. DataLoader 工廠
# ═══════════════════════════════════════════════
def make_loader(X, y, batch_size, shuffle):
    import torch
    from torch.utils.data import TensorDataset, DataLoader
    ds = TensorDataset(
        torch.tensor(X, dtype=torch.float32),
        torch.tensor(y, dtype=torch.long),
    )
    return DataLoader(ds, batch_size=batch_size, shuffle=shuffle)
# ═══════════════════════════════════════════════
#  6. LSTM 模型
# ═══════════════════════════════════════════════
def build_model(input_size=INPUT_SIZE):
    import torch
    import torch.nn as nn
    class GestureLSTM(nn.Module):
        def __init__(self):
            super().__init__()
            self.lstm = nn.LSTM(
                input_size  = input_size,
                hidden_size = HIDDEN_SIZE,
                num_layers  = NUM_LAYERS,
                batch_first = True,
                dropout     = DROPOUT if NUM_LAYERS > 1 else 0.0,
            )
            self.head = nn.Sequential(
                nn.Dropout(DROPOUT),
                nn.Linear(HIDDEN_SIZE * 2, 32),
                nn.ReLU(),
                nn.Dropout(DROPOUT),
                nn.Linear(32, len(CLASSES)),
            )
        def forward(self, x):
            out, _ = self.lstm(x)
            last = out[:, -1, :]
            peak = out.max(dim=1).values
            out = torch.cat([last, peak], dim=1)
            return self.head(out)
    return GestureLSTM()
# ═══════════════════════════════════════════════
#  7. 訓練主流程
# ═══════════════════════════════════════════════
def train(epochs=EPOCHS, resume=False):
    import torch
    import torch.nn as nn
    # ── 載入 & 特徵工程 ──
    X_raw, y = load_raw_data()
    X_3d     = [add_delta(seq) for seq in X_raw]
    # ── 先分割原始錄製（防資料洩漏）──
    trn_idx, val_idx = stratified_split_indices(y, test_size=0.25, random_state=42)
    print(f"[分割] 訓練原始:{len(trn_idx)}筆  驗證原始:{len(val_idx)}筆")
    X_trn_raw = [X_3d[i] for i in trn_idx];  y_trn = [y[i] for i in trn_idx]
    X_val_raw = [X_3d[i] for i in val_idx];  y_val = [y[i] for i in val_idx]
    # ── Scaler 只用訓練集 fit ──
    scaler = fit_scaler(X_trn_raw)
    pickle.dump(scaler, open(SCALER_PATH, "wb"))
    print(f"[前處理] Scaler 已儲存：{SCALER_PATH}")
    X_trn_norm = apply_scaler(X_trn_raw, scaler)
    X_val_norm = apply_scaler(X_val_raw, scaler)
    # ── 訓練集：滑動視窗 + 輕量擴增 ──
    X_trn_list, y_trn_list = [], []
    for arr, label in zip(X_trn_norm, y_trn):
        wins = sliding_windows(arr, SEQ_LEN, SLIDE_STEP)
        for w in wins:
            X_trn_list.append(w)
            y_trn_list.append(label)
            for _ in range(AUGMENT_TIMES):
                aug = augment_once(w)
                X_trn_list.append(pad_or_truncate(aug, SEQ_LEN))
                y_trn_list.append(label)
    X_trn     = np.array(X_trn_list, dtype=np.float32)
    y_trn_arr = np.array(y_trn_list, dtype=np.int64)
    # ── 驗證集：保留完整錄製（不做滑動視窗，確保真實準確率）──
    X_val     = np.array([pad_or_truncate(a, SEQ_LEN) for a in X_val_norm], dtype=np.float32)
    y_val_arr = np.array(y_val, dtype=np.int64)
    print(f"[滑動視窗] 訓練:{len(X_trn)}  驗證:{len(X_val)}（原始，無擴增）")
    trn_loader = make_loader(X_trn, y_trn_arr, BATCH_SIZE, shuffle=True)
    val_loader = make_loader(X_val, y_val_arr, BATCH_SIZE, shuffle=False)
    # ── 模型 / 優化器 ──
    device    = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model     = build_model().to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=LR, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, patience=20, factor=0.5)
    criterion = nn.CrossEntropyLoss()
    best_val_acc = 0.0

    if resume and os.path.exists(MODEL_PATH):
        ckpt = torch.load(MODEL_PATH, map_location=device, weights_only=False)
        model.load_state_dict(ckpt["model_state_dict"])
        if "optimizer_state_dict" in ckpt:
            optimizer.load_state_dict(ckpt["optimizer_state_dict"])
        best_val_acc = float(ckpt.get("best_val_acc", 0.0))
        print(f"[續訓] 已載入既有模型：{MODEL_PATH} (best_val_acc={best_val_acc:.1%})")

    print(f"[訓練] 裝置:{device}  開始訓練 {epochs} epochs ...\n")
    n_trn, n_val = len(X_trn), len(X_val)
    for epoch in range(1, epochs + 1):
        model.train()
        trn_loss = trn_correct = 0
        for xb, yb in trn_loader:
            xb, yb = xb.to(device), yb.to(device)
            optimizer.zero_grad()
            logits = model(xb)
            loss   = criterion(logits, yb)
            loss.backward()
            optimizer.step()
            trn_loss    += loss.item() * len(xb)
            trn_correct += (logits.argmax(1) == yb).sum().item()
        model.eval()
        val_loss = val_correct = 0
        with torch.no_grad():
            for xb, yb in val_loader:
                xb, yb = xb.to(device), yb.to(device)
                logits  = model(xb)
                val_loss    += criterion(logits, yb).item() * len(xb)
                val_correct += (logits.argmax(1) == yb).sum().item()
        trn_acc = trn_correct / n_trn
        val_acc = val_correct / n_val
        scheduler.step(val_loss / n_val)
        if epoch % 20 == 0 or epoch == epochs:
            print(f"Epoch {epoch:3d}/{epochs} | "
                  f"Train {trn_loss/n_trn:.4f} {trn_acc:.1%} | "
                  f"Val {val_loss/n_val:.4f} {val_acc:.1%}")
        if val_acc >= best_val_acc:
            best_val_acc = val_acc
            torch.save({
                "model_state_dict": model.state_dict(),
                "optimizer_state_dict": optimizer.state_dict(),
                "best_val_acc": best_val_acc,
                "config": {
                    "input_size"    : INPUT_SIZE,
                    "hidden_size"   : HIDDEN_SIZE,
                    "num_layers"    : NUM_LAYERS,
                    "dropout"       : DROPOUT,
                    "seq_len"       : SEQ_LEN,
                    "classes"       : CLASSES,
                    "base_features" : BASE_FEATURES,
                    "num_classes"   : len(CLASSES),
                },
            }, MODEL_PATH)
    print(f"\n[完成] 最佳驗證準確率：{best_val_acc:.1%}")
    print(f"[完成] 模型已儲存：{MODEL_PATH}")
# ═══════════════════════════════════════════════
#  8. 推論
# ═══════════════════════════════════════════════
def predict(recording: list) -> tuple:
    """
    recording : list of dict，格式同 JSON
    回傳 (pred_class:str, probs:np.array)
    """
    import torch
    ckpt   = torch.load(MODEL_PATH, map_location="cpu", weights_only=True)
    cfg    = ckpt["config"]
    scaler = pickle.load(open(SCALER_PATH, "rb"))
    model = build_model(cfg["input_size"])
    model.load_state_dict(ckpt["model_state_dict"])
    model.eval()
    seq_2d   = [extract_base_features(frame) for frame in recording]
    seq_3d   = add_delta(seq_2d)
    seq_norm = scaler.transform(seq_3d).astype(np.float32)
    seq_pad  = pad_or_truncate(seq_norm, cfg["seq_len"])
    X = torch.tensor(seq_pad, dtype=torch.float32).unsqueeze(0)
    with torch.no_grad():
        probs = torch.softmax(model(X), dim=1).squeeze().numpy()
    pred_idx   = int(probs.argmax())
    pred_class = cfg["classes"][pred_idx]
    print("\n[推論結果]")
    for i, cls in enumerate(cfg["classes"]):
        bar = "█" * int(probs[i] * 40)
        print(f"  {cls:12s}  {probs[i]:6.1%}  {bar}")
    print(f"\n  → 預測動作：{pred_class}  (信心 {probs[pred_idx]:.1%})")
    return pred_class, probs
# ═══════════════════════════════════════════════
#  進入點
# ═══════════════════════════════════════════════
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--predict", action="store_true",
                        help="用第一筆 wave 資料測試推論")
    parser.add_argument("--epochs", type=int, default=EPOCHS,
                        help="訓練 epoch 數，預設 200")
    parser.add_argument("--resume", action="store_true",
                        help="從既有 lstm_model.pth 繼續訓練")
    args = parser.parse_args()
    if args.predict:
        wave_data = json.load(open(os.path.join(DATA_DIR, "wave.json"), encoding="utf-8"))
        predict(wave_data[0])
    else:
        train(epochs=args.epochs, resume=args.resume)