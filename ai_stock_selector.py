from __future__ import annotations

import math
import os
import sys
import threading
import time
import traceback
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

import numpy as np
import pandas as pd
from flask import Flask, jsonify, render_template, request

try:
    import akshare as ak
except Exception:  # pragma: no cover - surfaced through health endpoint/UI
    ak = None


app = Flask(__name__)

CACHE_TTL = 60
_spot_cache: dict[str, Any] = {"ts": 0.0, "df": None}
_kline_cache: dict[str, Any] = {}
_history_cache: dict[str, Any] = {}
_index_cache: dict[str, Any] = {"ts": 0.0, "data": None}
_akshare_lock = threading.RLock()
os.environ.setdefault("TQDM_DISABLE", "1")


@contextmanager
def quiet_akshare_output():
    """Keep a hook around AKShare calls without serializing web requests."""
    yield


def log_exception(context: str, exc: Exception) -> None:
    message = f"\n[{datetime.now():%Y-%m-%d %H:%M:%S}] {context}: {exc!r}\n"
    message += traceback.format_exc()
    try:
        with open("server.err.log", "a", encoding="utf-8") as file:
            file.write(message)
    except Exception:
        pass


@dataclass
class HorizonResult:
    label: str
    stance: str
    score: float
    confidence: float
    summary: str
    support: float | None
    pressure: float | None


def _safe_float(value: Any) -> float | None:
    try:
        if value is None or pd.isna(value):
            return None
        value = float(value)
        if math.isfinite(value):
            return value
    except Exception:
        return None
    return None


def _json_records(df: pd.DataFrame, limit: int | None = None) -> list[dict[str, Any]]:
    if limit:
        df = df.head(limit)
    clean = df.replace({np.nan: None})
    return clean.to_dict(orient="records")


def build_market_charts(valid: pd.DataFrame) -> dict[str, Any]:
    bins = [
        ("<=-10%", -float("inf"), -10),
        ("-10%~-5%", -10, -5),
        ("-5%~-2%", -5, -2),
        ("-2%~0%", -2, 0),
        ("0%~2%", 0, 2),
        ("2%~5%", 2, 5),
        ("5%~10%", 5, 10),
        (">=10%", 10, float("inf")),
    ]
    pct = valid["pct_change"]
    distribution = [
        {"label": label, "count": int(((pct >= low) & (pct < high)).sum())}
        for label, low, high in bins
    ]
    breadth = [
        {"label": "上涨", "count": int((pct > 0).sum()), "color": "#dc2626"},
        {"label": "平盘", "count": int((pct == 0).sum()), "color": "#94a3b8"},
        {"label": "下跌", "count": int((pct < 0).sum()), "color": "#16a34a"},
    ]
    amount_leaders = (
        valid.dropna(subset=["amount"])
        .sort_values("amount", ascending=False)
        .head(10)[["code", "name", "amount", "pct_change"]]
    )
    return {
        "breadth": breadth,
        "pct_distribution": distribution,
        "amount_leaders": _json_records(amount_leaders),
    }


def build_synthetic_market_line(valid: pd.DataFrame) -> list[dict[str, Any]]:
    pct = valid["pct_change"].dropna()
    if pct.empty:
        return []
    avg = float(pct.mean())
    volatility = float(pct.std() or 0.5)
    now = datetime.now()
    points = []
    value = 100.0
    for i in range(48):
        wave = math.sin(i / 5.5) * volatility * 0.08
        drift = avg * (i / 47) * 0.18
        value = 100 + drift + wave
        points.append(
            {
                "date": (now - timedelta(minutes=(47 - i) * 5)).strftime("%H:%M"),
                "close": round(value, 3),
                "pct_change": round(value - 100, 3),
            }
        )
    return points


def load_market_trend() -> dict[str, Any]:
    now = time.time()
    if _index_cache["data"] is not None and now - _index_cache["ts"] < 300:
        return _index_cache["data"]
    index_defs = [
        {"code": "sh000001", "name": "上证指数"},
        {"code": "sz399001", "name": "深证成指"},
        {"code": "sz399006", "name": "创业板指"},
        {"code": "sh000300", "name": "沪深300"},
    ]
    end = datetime.now()
    start = end - timedelta(days=220)
    series = []
    for item in index_defs:
        try:
            with quiet_akshare_output():
                raw = ak.stock_zh_index_daily_tx(
                    symbol=item["code"],
                    start_date=_format_date(start),
                    end_date=_format_date(end),
                )
            df = normalize_ohlcv(raw)
            if df.empty:
                raise RuntimeError("empty index data")
            rows = df.tail(120).copy()
            rows["pct_change"] = rows["close"].pct_change() * 100
            rows["date"] = rows["date"].dt.strftime("%Y-%m-%d")
            latest = rows.iloc[-1]
            series.append(
                {
                    "code": item["code"],
                    "name": item["name"],
                    "latest": _safe_float(latest["close"]),
                    "pct_change": _safe_float(latest.get("pct_change")),
                    "points": _json_records(rows[["date", "close", "pct_change"]]),
                    "source": "腾讯指数日线",
                }
            )
        except Exception:
            continue
    if not series:
        valid = get_spot_df().dropna(subset=["pct_change"])
        synthetic = build_synthetic_market_line(valid)
        series = [
            {
                "code": "market-breadth",
                "name": "A股市场温度",
                "latest": synthetic[-1]["close"] if synthetic else None,
                "pct_change": synthetic[-1]["pct_change"] if synthetic else None,
                "points": synthetic,
                "source": "实时股票涨跌幅合成",
            }
        ]
    payload = {"updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "series": series}
    _index_cache.update({"ts": now, "data": payload})
    return payload


def _format_date(dt: datetime) -> str:
    return dt.strftime("%Y%m%d")


def get_spot_df(force: bool = False) -> pd.DataFrame:
    if ak is None:
        raise RuntimeError("AKShare 未安装或导入失败，请先安装 requirements.txt。")

    now = time.time()
    if not force and _spot_cache["df"] is not None and now - _spot_cache["ts"] < CACHE_TTL:
        return _spot_cache["df"].copy()

    try:
        with quiet_akshare_output():
            df = ak.stock_zh_a_spot_em()
    except Exception:
        with quiet_akshare_output():
            df = ak.stock_zh_a_spot()
    rename_map = {
        "代码": "code",
        "名称": "name",
        "最新价": "price",
        "涨跌幅": "pct_change",
        "涨跌额": "change",
        "成交量": "volume",
        "成交额": "amount",
        "振幅": "amplitude",
        "最高": "high",
        "最低": "low",
        "今开": "open",
        "昨收": "prev_close",
        "量比": "volume_ratio",
        "换手率": "turnover",
        "市盈率-动态": "pe",
        "市净率": "pb",
        "总市值": "market_cap",
        "流通市值": "float_market_cap",
        "涨速": "speed",
        "5分钟涨跌": "change_5m",
        "60日涨跌幅": "pct_60d",
        "年初至今涨跌幅": "pct_ytd",
    }
    df = df.rename(columns=rename_map)
    keep = [c for c in rename_map.values() if c in df.columns]
    df = df[keep].copy()
    for col in keep:
        if col not in {"code", "name"}:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    df["code"] = (
        df["code"]
        .astype(str)
        .str.extract(r"(\d{6})", expand=False)
        .fillna(df["code"].astype(str))
        .str.zfill(6)
    )
    df["name"] = df["name"].astype(str)
    _spot_cache.update({"ts": now, "df": df})
    return df.copy()


def find_stock(query: str) -> dict[str, Any] | None:
    q = query.strip().upper()
    if not q:
        return None
    df = get_spot_df()
    if q.isdigit():
        match = df[df["code"].str.startswith(q)]
    else:
        match = df[df["name"].str.contains(q, case=False, regex=False)]
    if match.empty:
        return None
    return match.iloc[0].replace({np.nan: None}).to_dict()


def find_stock_cached(query: str) -> dict[str, Any] | None:
    q = str(query).strip().upper()
    if not q:
        return None
    cached_df = _spot_cache.get("df")
    if cached_df is None:
        return {"code": q.zfill(6), "name": q.zfill(6)} if q.isdigit() else None
    df = cached_df.copy()
    if q.isdigit():
        match = df[df["code"].str.startswith(q)]
    else:
        match = df[df["name"].str.contains(q, case=False, regex=False)]
    if match.empty:
        return {"code": q.zfill(6), "name": q.zfill(6)} if q.isdigit() else None
    return match.iloc[0].replace({np.nan: None}).to_dict()


def load_history(code: str) -> pd.DataFrame:
    if ak is None:
        raise RuntimeError("AKShare 未安装或导入失败，请先安装 requirements.txt。")
    code = str(code).strip()
    cached = _history_cache.get(code)
    if cached and time.time() - cached["ts"] < 900:
        return cached["df"].copy()
    end = datetime.now()
    start = end - timedelta(days=520)
    market = market_prefix(code)
    try:
        with quiet_akshare_output():
            df = ak.stock_zh_a_daily(
                symbol=f"{market}{code}",
                start_date=_format_date(start),
                end_date=_format_date(end),
                adjust="qfq",
            )
    except Exception:
        try:
            with quiet_akshare_output():
                df = ak.stock_zh_a_hist(
                    symbol=code,
                    period="daily",
                    start_date=_format_date(start),
                    end_date=_format_date(end),
                    adjust="qfq",
                )
        except Exception:
            with quiet_akshare_output():
                df = ak.stock_zh_a_hist_tx(
                    symbol=f"{market}{code}",
                    start_date=_format_date(start),
                    end_date=_format_date(end),
                    adjust="qfq",
                )
    if df.empty:
        return df
    rename_map = {
        "日期": "date",
        "开盘": "open",
        "收盘": "close",
        "最高": "high",
        "最低": "low",
        "成交量": "volume",
        "成交额": "amount",
        "振幅": "amplitude",
        "涨跌幅": "pct_change",
        "涨跌额": "change",
        "换手率": "turnover",
    }
    df = df.rename(columns=rename_map)
    df["date"] = pd.to_datetime(df["date"])
    for col in [c for c in df.columns if c != "date"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    if "pct_change" not in df.columns:
        df["pct_change"] = df["close"].pct_change() * 100
    if "change" not in df.columns:
        df["change"] = df["close"].diff()
    if "volume" not in df.columns and "amount" in df.columns:
        df["volume"] = df["amount"]
    for optional_col in ["amount", "amplitude", "turnover"]:
        if optional_col not in df.columns:
            df[optional_col] = np.nan
    df = df.sort_values("date").reset_index(drop=True)
    _history_cache[code] = {"ts": time.time(), "df": df.copy()}
    return df


def add_indicators(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    close = out["close"]
    high = out["high"]
    low = out["low"]
    volume = out["volume"]

    for window in [5, 10, 20, 60, 120]:
        out[f"ma{window}"] = close.rolling(window).mean()

    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    out["dif"] = ema12 - ema26
    out["dea"] = out["dif"].ewm(span=9, adjust=False).mean()
    out["macd"] = (out["dif"] - out["dea"]) * 2

    delta = close.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta.clip(upper=0)).rolling(14).mean()
    rs = gain / loss.replace(0, np.nan)
    out["rsi14"] = 100 - (100 / (1 + rs))

    low9 = low.rolling(9).min()
    high9 = high.rolling(9).max()
    rsv = (close - low9) / (high9 - low9).replace(0, np.nan) * 100
    out["kdj_k"] = rsv.ewm(com=2, adjust=False).mean()
    out["kdj_d"] = out["kdj_k"].ewm(com=2, adjust=False).mean()
    out["kdj_j"] = 3 * out["kdj_k"] - 2 * out["kdj_d"]

    out["boll_mid"] = out["ma20"]
    out["boll_std"] = close.rolling(20).std()
    out["boll_up"] = out["boll_mid"] + 2 * out["boll_std"]
    out["boll_low"] = out["boll_mid"] - 2 * out["boll_std"]
    out["vol_ma5"] = volume.rolling(5).mean()
    out["vol_ma20"] = volume.rolling(20).mean()
    out["ret1"] = close.pct_change()
    out["ret5"] = close.pct_change(5)
    out["ret20"] = close.pct_change(20)
    out["ret60"] = close.pct_change(60)
    return out


def market_prefix(code: str) -> str:
    return "sh" if str(code).startswith(("5", "6", "9")) else "bj" if str(code).startswith(("4", "8")) else "sz"


def normalize_ohlcv(df: pd.DataFrame) -> pd.DataFrame:
    rename_map = {
        "时间": "date",
        "日期": "date",
        "day": "date",
        "开盘": "open",
        "open": "open",
        "收盘": "close",
        "close": "close",
        "最高": "high",
        "high": "high",
        "最低": "low",
        "low": "low",
        "成交量": "volume",
        "volume": "volume",
        "成交额": "amount",
        "amount": "amount",
    }
    out = df.rename(columns=rename_map).copy()
    required = ["date", "open", "close", "high", "low", "volume"]
    if any(col not in out.columns for col in required):
        return pd.DataFrame()
    keep = required + (["amount"] if "amount" in out.columns else [])
    out = out[keep].copy()
    out["date"] = pd.to_datetime(out["date"], errors="coerce")
    for col in [c for c in out.columns if c != "date"]:
        out[col] = pd.to_numeric(out[col], errors="coerce")
    if "amount" not in out.columns:
        out["amount"] = np.nan
    return out.dropna(subset=["date", "open", "close", "high", "low"]).sort_values("date").reset_index(drop=True)


def aggregate_minutes(df: pd.DataFrame, target_period: int) -> pd.DataFrame:
    if target_period <= 60:
        return df
    group_size = max(1, target_period // 30)
    out = df.copy().reset_index(drop=True)
    out["group"] = np.arange(len(out)) // group_size
    grouped = out.groupby("group", as_index=False).agg(
        date=("date", "last"),
        open=("open", "first"),
        close=("close", "last"),
        high=("high", "max"),
        low=("low", "min"),
        volume=("volume", "sum"),
        amount=("amount", "sum"),
    )
    return grouped.drop(columns=["group"], errors="ignore")


def add_kline_indicators(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    close = out["close"]
    for window in [5, 10, 20, 60]:
        out[f"ma{window}"] = close.rolling(window, min_periods=1).mean()
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    out["dif"] = ema12 - ema26
    out["dea"] = out["dif"].ewm(span=9, adjust=False).mean()
    out["macd"] = (out["dif"] - out["dea"]) * 2
    return out


def detect_macd_divergence(df: pd.DataFrame) -> dict[str, Any]:
    rows = df.dropna(subset=["close", "dif", "macd"]).tail(80).reset_index(drop=True)
    if len(rows) < 20:
        return {"type": "none", "title": "暂无背离", "summary": "样本不足，暂不判断 MACD 背离。"}
    highs = []
    lows = []
    for i in range(2, len(rows) - 2):
        close = float(rows.loc[i, "close"])
        if close >= rows.loc[i - 2 : i + 2, "close"].max():
            highs.append(i)
        if close <= rows.loc[i - 2 : i + 2, "close"].min():
            lows.append(i)
    if len(highs) >= 2:
        a, b = highs[-2], highs[-1]
        price_a = float(rows.loc[a, "close"])
        price_b = float(rows.loc[b, "close"])
        dif_a = float(rows.loc[a, "dif"])
        dif_b = float(rows.loc[b, "dif"])
        if price_b > price_a and dif_b < dif_a:
            return {
                "type": "top",
                "title": "疑似顶背离",
                "summary": f"价格新高从 {price_a:.2f} 到 {price_b:.2f}，但 DIF 从 {dif_a:.3f} 回落到 {dif_b:.3f}，短线动能减弱，需防冲高回落。",
                "points": [int(a), int(b)],
            }
    if len(lows) >= 2:
        a, b = lows[-2], lows[-1]
        price_a = float(rows.loc[a, "close"])
        price_b = float(rows.loc[b, "close"])
        dif_a = float(rows.loc[a, "dif"])
        dif_b = float(rows.loc[b, "dif"])
        if price_b < price_a and dif_b > dif_a:
            return {
                "type": "bottom",
                "title": "疑似底背离",
                "summary": f"价格新低从 {price_a:.2f} 到 {price_b:.2f}，但 DIF 从 {dif_a:.3f} 抬升到 {dif_b:.3f}，下行动能收敛，关注企稳反弹。",
                "points": [int(a), int(b)],
            }
    latest = rows.iloc[-1]
    direction = "多头" if float(latest["dif"]) > float(latest["dea"]) else "空头"
    return {
        "type": "none",
        "title": "未发现明显背离",
        "summary": f"最近波段未形成标准顶/底背离，当前 MACD 结构偏{direction}，以趋势跟随为主。",
    }


def load_intraday_kline(code: str, period: int) -> tuple[pd.DataFrame, str]:
    if ak is None:
        raise RuntimeError("AKShare is not available")
    code = str(code).strip()
    target_period = period if period in {60, 90, 120} else 60
    cache_key = f"{code}:{target_period}"
    cached = _kline_cache.get(cache_key)
    if cached and time.time() - cached["ts"] < 300:
        return cached["df"].copy(), cached["source"]
    source_period = "60" if target_period == 60 else "30"
    source = f"{source_period}分钟线"
    market_code = f"{market_prefix(code)}{code}"
    end = datetime.now()
    start = end - timedelta(days=45)
    try:
        with quiet_akshare_output():
            raw = ak.stock_zh_a_minute(symbol=market_code, period=source_period, adjust="qfq")
        df = normalize_ohlcv(raw)
        if df.empty:
            raise RuntimeError("empty minute data")
    except Exception:
        with quiet_akshare_output():
            raw = ak.stock_zh_a_hist_min_em(
                symbol=code,
                start_date=start.strftime("%Y-%m-%d %H:%M:%S"),
                end_date=end.strftime("%Y-%m-%d %H:%M:%S"),
                period=source_period,
                adjust="qfq",
            )
        df = normalize_ohlcv(raw)
    if df.empty:
        daily = add_kline_indicators(load_history(code)).tail(120).copy()
        daily["date"] = daily["date"].dt.strftime("%Y-%m-%d")
        _kline_cache[cache_key] = {"ts": time.time(), "df": daily.copy(), "source": "分钟源暂不可用，临时显示日线"}
        return daily, "分钟源暂不可用，临时显示日线"
    if target_period in {90, 120}:
        df = aggregate_minutes(df, target_period)
        source = f"30分钟聚合为{target_period}分钟线"
    df = add_kline_indicators(df).tail(180).replace({np.nan: None}).copy()
    df["date"] = df["date"].dt.strftime("%Y-%m-%d %H:%M")
    _kline_cache[cache_key] = {"ts": time.time(), "df": df.copy(), "source": source}
    return df, source


def score_to_stance(score: float) -> str:
    if score >= 65:
        return "看多"
    if score >= 53:
        return "偏多"
    if score > 47:
        return "中性"
    if score > 35:
        return "偏空"
    return "看空"


def clamp_score(raw: float) -> float:
    return float(round(max(0, min(100, float(raw))), 1))


def _pct(value: float | None) -> str:
    if value is None:
        return "暂无"
    return f"{value * 100:+.2f}%"


def build_backtest(df: pd.DataFrame) -> dict[str, Any]:
    close = df["close"]
    windows = {
        "次日": 1,
        "下一周": 5,
        "一个月": 20,
        "三个月": 60,
    }
    rows = []
    for label, n in windows.items():
        future = close.shift(-n) / close - 1
        recent = future.dropna().tail(240)
        rows.append(
            {
                "label": label,
                "avg_return": _safe_float(recent.mean()),
                "median_return": _safe_float(recent.median()),
                "win_rate": _safe_float((recent > 0).mean()),
                "sample_size": int(recent.count()),
            }
        )
    return {"rows": rows}


def build_indicator_table(last: pd.Series, prev: pd.Series) -> list[dict[str, Any]]:
    close = _safe_float(last.get("close"))
    rows = []

    def add(name: str, value: float | None, signal: str, detail: str) -> None:
        rows.append(
            {
                "name": name,
                "value": None if value is None else round(value, 3),
                "signal": signal,
                "detail": detail,
            }
        )

    ma5 = _safe_float(last.get("ma5"))
    ma20 = _safe_float(last.get("ma20"))
    ma60 = _safe_float(last.get("ma60"))
    ma120 = _safe_float(last.get("ma120"))
    macd = _safe_float(last.get("macd"))
    prev_macd = _safe_float(prev.get("macd"))
    rsi = _safe_float(last.get("rsi14"))
    k = _safe_float(last.get("kdj_k"))
    d = _safe_float(last.get("kdj_d"))
    boll_up = _safe_float(last.get("boll_up"))
    boll_low = _safe_float(last.get("boll_low"))
    vol = _safe_float(last.get("volume"))
    vol_ma20 = _safe_float(last.get("vol_ma20"))

    add("均线趋势", ma20, "偏多" if close and ma5 and ma20 and close > ma5 > ma20 else "偏空" if close and ma20 and close < ma20 else "中性", f"收盘价相对 MA5/MA20/MA60/MA120 判断趋势层级。")
    add("MACD", macd, "金叉/走强" if macd and macd > 0 and (prev_macd is None or macd >= prev_macd) else "死叉/转弱" if macd and macd < 0 else "中性", "DIF-DEA 柱体用于判断动能扩张或收缩。")
    add("RSI(14)", rsi, "强势" if rsi and 55 <= rsi <= 70 else "超买" if rsi and rsi > 70 else "弱势" if rsi and rsi < 45 else "中性", "RSI 衡量短线涨跌力度，过高需防追高。")
    add("KDJ", k, "短线强" if k and d and k > d and k < 85 else "超买" if k and k >= 85 else "短线弱" if k and d and k < d else "中性", "K/D/J 对短线拐点更敏感。")
    add("布林带", boll_up, "突破上轨" if close and boll_up and close > boll_up else "靠近下轨" if close and boll_low and close < boll_low * 1.03 else "区间内", "价格相对上下轨判断波动区间和突破状态。")
    add("量能", vol, "放量" if vol and vol_ma20 and vol > vol_ma20 * 1.35 else "缩量" if vol and vol_ma20 and vol < vol_ma20 * 0.75 else "正常", "成交量与 20 日均量比较，辅助确认突破有效性。")
    return rows


def build_horizon_results(df: pd.DataFrame) -> list[HorizonResult]:
    last = df.iloc[-1]
    prev = df.iloc[-2] if len(df) > 1 else last
    close = _safe_float(last["close"]) or 0
    ma5 = _safe_float(last.get("ma5"))
    ma20 = _safe_float(last.get("ma20"))
    ma60 = _safe_float(last.get("ma60"))
    ma120 = _safe_float(last.get("ma120"))
    macd = _safe_float(last.get("macd")) or 0
    prev_macd = _safe_float(prev.get("macd")) or 0
    rsi = _safe_float(last.get("rsi14")) or 50
    k = _safe_float(last.get("kdj_k")) or 50
    d = _safe_float(last.get("kdj_d")) or 50
    ret5 = _safe_float(last.get("ret5")) or 0
    ret20 = _safe_float(last.get("ret20")) or 0
    ret60 = _safe_float(last.get("ret60")) or 0
    vol = _safe_float(last.get("volume")) or 0
    vol_ma20 = _safe_float(last.get("vol_ma20")) or vol

    macd_rising = macd > prev_macd
    volume_boost = vol_ma20 > 0 and vol / vol_ma20

    short = 50
    short += 12 if close and ma5 and close > ma5 else -8
    short += 12 if macd > 0 and macd_rising else -10 if macd < 0 else 0
    short += 8 if k > d and k < 85 else -8 if k < d else 0
    short += 7 if 52 <= rsi <= 68 else -8 if rsi < 45 or rsi > 75 else 0
    short += 5 if volume_boost > 1.2 else -3 if volume_boost < 0.75 else 0

    mid = 50
    mid += 13 if close and ma20 and close > ma20 else -12
    mid += 10 if ma5 and ma20 and ma5 > ma20 else -8
    mid += 9 if macd > 0 else -9
    mid += 8 if ret20 > 0 else -8
    mid += 4 if 45 <= rsi <= 70 else -5

    long = 50
    long += 14 if close and ma60 and close > ma60 else -12
    long += 10 if ma60 and ma120 and ma60 > ma120 else -8
    long += 10 if ret60 > 0 else -8
    long += 6 if close and ma20 and ma60 and ma20 > ma60 else -5

    lows = df["low"].tail(20)
    highs = df["high"].tail(20)
    support = _safe_float(lows.quantile(0.25))
    pressure = _safe_float(highs.quantile(0.75))

    scored = [
        ("短期（次日）", clamp_score(short), "短线由价格相对 MA5、MACD 柱体、KDJ 和量能共同判断。", support, pressure),
        ("中期（下一周至一个月）", clamp_score(mid), "中期重点看 MA20、MACD 方向、20 日收益和趋势持续性。", ma20 or support, pressure),
        ("长期（一个月以上）", clamp_score(long), "长期更看重 MA60/MA120 结构、60 日收益和趋势位置。", ma60 or support, _safe_float(df["high"].tail(60).quantile(0.8))),
    ]
    return [
        HorizonResult(
            label=label,
            stance=score_to_stance(score),
            score=score,
            confidence=round(abs(score - 50) / 50, 2),
            summary=summary,
            support=None if support_v is None else round(support_v, 2),
            pressure=None if pressure_v is None else round(pressure_v, 2),
        )
        for label, score, summary, support_v, pressure_v in scored
    ]


def build_analysis(code: str) -> dict[str, Any]:
    spot = find_stock_cached(code)
    actual_code = (spot or {}).get("code", code)
    hist = load_history(actual_code)
    if hist.empty or len(hist) < 80:
        raise RuntimeError("历史行情数据不足，无法完成量化分析。")
    hist = add_indicators(hist)
    last = hist.iloc[-1]
    prev = hist.iloc[-2]
    horizons = build_horizon_results(hist)
    indicators = build_indicator_table(last, prev)
    backtest = build_backtest(hist)
    overall_score = float(round(float(np.mean([h.score for h in horizons])), 1))
    overall_stance = score_to_stance(overall_score)
    history_payload = hist.tail(260).replace({np.nan: None}).copy()
    history_payload["date"] = history_payload["date"].dt.strftime("%Y-%m-%d")

    return {
        "code": actual_code,
        "name": (spot or {}).get("name", actual_code),
        "spot": spot,
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "latest": {
            "date": last["date"].strftime("%Y-%m-%d"),
            "close": _safe_float(last["close"]),
            "pct_change": _safe_float(last.get("pct_change")),
            "volume": _safe_float(last.get("volume")),
            "amount": _safe_float(last.get("amount")),
            "turnover": _safe_float(last.get("turnover")),
        },
        "overall": {
            "stance": overall_stance,
            "score": overall_score,
            "conclusion": f"综合短中长期模型当前为“{overall_stance}”，量化分 {overall_score}/100；建议结合大盘环境、行业强弱和个股公告再做决策。",
        },
        "horizons": [h.__dict__ for h in horizons],
        "indicators": indicators,
        "backtest": backtest,
        "history": _json_records(history_payload),
    }


@app.route("/")
@app.route("/stock/<path:stock_query>")
def index(stock_query: str | None = None):
    return render_template("index.html", stock_query=stock_query or "")


@app.get("/api/market")
def api_market():
    try:
        df = get_spot_df(force=request.args.get("refresh") == "1")
        valid = df.dropna(subset=["pct_change"]).copy()
        gainers = valid.sort_values("pct_change", ascending=False).head(10)
        losers = valid.sort_values("pct_change", ascending=True).head(10)
        market = {
            "total": int(len(valid)),
            "up": int((valid["pct_change"] > 0).sum()),
            "flat": int((valid["pct_change"] == 0).sum()),
            "down": int((valid["pct_change"] < 0).sum()),
            "avg_pct_change": _safe_float(valid["pct_change"].mean()),
            "amount": _safe_float(valid["amount"].sum()),
        }
        table = valid.sort_values("amount", ascending=False).head(80)
        charts = build_market_charts(valid)
        return jsonify(
            {
                "ok": True,
                "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "market": market,
                "charts": charts,
                "gainers": _json_records(gainers),
                "losers": _json_records(losers),
                "table": _json_records(table),
            }
        )
    except Exception as exc:
        log_exception("api_market", exc)
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.get("/api/search")
def api_search():
    q = request.args.get("q", "").strip()
    try:
        df = get_spot_df()
        if q.isdigit():
            matches = df[df["code"].str.startswith(q)]
        else:
            matches = df[df["name"].str.contains(q, case=False, regex=False)]
        return jsonify({"ok": True, "items": _json_records(matches[["code", "name", "price", "pct_change"]], 10)})
    except Exception as exc:
        log_exception("api_search", exc)
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.get("/api/market/trend")
def api_market_trend():
    try:
        return jsonify({"ok": True, "data": load_market_trend()})
    except Exception as exc:
        log_exception("api_market_trend", exc)
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.get("/api/quotes")
def api_quotes():
    try:
        codes = [code.strip().zfill(6) for code in request.args.get("codes", "").split(",") if code.strip()]
        df = get_spot_df()
        result = df[df["code"].isin(codes)] if codes else df.head(0)
        return jsonify({"ok": True, "items": _json_records(result)})
    except Exception as exc:
        log_exception("api_quotes", exc)
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.get("/api/stock/<path:stock_query>")
def api_stock(stock_query: str):
    try:
        result = build_analysis(stock_query)
        return jsonify({"ok": True, "data": result})
    except Exception as exc:
        log_exception("api_stock", exc)
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.get("/api/stock/<path:stock_query>/kline")
def api_stock_kline(stock_query: str):
    try:
        period = int(request.args.get("period", "60"))
        spot = find_stock_cached(stock_query)
        actual_code = (spot or {}).get("code", stock_query)
        df, source = load_intraday_kline(actual_code, period)
        payload = df.replace({np.nan: None}).to_dict(orient="records")
        return jsonify(
            {
                "ok": True,
                "code": actual_code,
                "name": (spot or {}).get("name", actual_code),
                "period": period if period in {60, 90, 120} else 60,
                "source": source,
                "divergence": detect_macd_divergence(df),
                "items": payload,
            }
        )
    except Exception as exc:
        log_exception("api_stock_kline", exc)
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.get("/api/health")
def api_health():
    return jsonify({"ok": ak is not None, "akshare": ak is not None})


if __name__ == "__main__":
    if sys.stdout is None:
        sys.stdout = open("server.log", "a", encoding="utf-8", buffering=1)
    if sys.stderr is None:
        sys.stderr = open("server.err.log", "a", encoding="utf-8", buffering=1)
    port = int(os.environ.get("PORT", "5000"))
    host = os.environ.get("HOST", "127.0.0.1")
    app.run(host=host, port=port, debug=False, threaded=True)
