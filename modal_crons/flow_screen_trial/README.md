# flow_screen_trial/ — snapshot phuc vu trial Modal (27/10/2026)

- `direct_fetch.py`: copy byte-identical cua `stock-app/scripts/direct_fetch.py` (27/10).
- `flow_screen_daily.py`: copy byte-identical cua `stock-app/scripts/flow_screen_daily.py` (27/10, ban da co CMF20/OBV20/MFI14).
- `universe.json`: 1.520 symbol distinct trong warehouse `screener_history`, xuat ngay 27/10.

KHONG sua rieng cac file nay — sua ban goc o stock-app roi copy lai
khi can trial tiep. Muc dich duy nhat: `modal run` tren runner khong
co stock-app, nen file can thiet phai nam trong repo (pattern giong
`modal_crons/direct_fetch.py` cua tick collector).
