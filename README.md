# A股量化分析网页

本项目使用 [AKShare](https://github.com/akfamily/akshare) 抓取 A 股实时行情和历史行情，提供首页市场概览、涨跌幅榜、股票搜索，以及个股短期/中期/长期量化分析。

## 运行

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python .\ai_stock_selector.py
```

打开浏览器访问：

```text
http://127.0.0.1:5000
```

## 功能

- 首页实时显示 A 股市场概览
- 展示当前涨幅和跌幅最大的 10 支股票
- 支持右上角输入股票代码或名称搜索
- 个股页展示历史行情、收益回顾、MACD/RSI/KDJ/均线/布林/量能分析
- 给出短期（次日）、中期（下一周至一个月）、长期（一个月以上）结论

数据来自 AKShare。分析仅供研究参考，不构成投资建议。
