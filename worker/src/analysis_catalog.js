// worker/src/analysis_catalog.js — danh muc phep tinh cho
// get_analysis_catalog (GD2, Phu luc G8): 1 nguon su that cho
// enum/cong thuc cua cac tool analyze_*/calc_*. Moi muc: name,
// label, params, unit, formula, min_bars (neu co), status.
// Bo chi bao chuan dung chung: pp_common_v1 (Phu luc H1.2).

const IND = (name, label, params, unit, formula, min_bars) => ({
  name, label, params, unit, formula, min_bars, uses_future_data: false, status: 'verified',
});
const FOR = (name, label, formula, note) => ({
  name, label, formula, note: note || null, uses_future_data: false, status: 'verified',
});
const RAT = (name, label, unit, formula) => ({
  name, label, unit, formula, verification: 'parity_pending', status: 'verified',
});

export const ANALYSIS_CATALOG = {
  indicators: [
    IND('sma_10', 'Trung binh dong don gian 10 phien', 'n=10', 'VND', 'SMA = tong close n phien gan nhat / n', 10),
    IND('sma_20', 'Trung binh dong don gian 20 phien', 'n=20', 'VND', 'SMA = tong close n phien gan nhat / n', 20),
    IND('sma_50', 'Trung binh dong don gian 50 phien', 'n=50', 'VND', 'SMA = tong close n phien gan nhat / n', 50),
    IND('sma_150', 'Trung binh dong don gian 150 phien (dung trong Trend Template)', 'n=150', 'VND', 'SMA = tong close n phien gan nhat / n', 150),
    IND('sma_200', 'Trung binh dong don gian 200 phien', 'n=200', 'VND', 'SMA = tong close n phien gan nhat / n', 200),
    IND('ema_20', 'Trung binh dong mu 20 phien', 'n=20, k=2/(n+1)', 'VND', 'EMA_t = close_t*k + EMA_{t-1}*(1-k); khoi tao bang SMA 20 dau tien', 20),
    IND('rsi_14', 'RSI 14 (Wilder)', 'n=14, lam mu Wilder', '% (0-100)', 'RS = avgGain/avgLoss (Wilder smoothing); RSI = 100 - 100/(1+RS)', 15),
    IND('macd', 'MACD 12/26/9', 'fast=12, slow=26, signal=9', 'VND', 'MACD = EMA12 - EMA26; signal = EMA9 cua MACD; hist = MACD - signal (x1 theo TA-Lib)', 35),
    IND('bbands_20_2', 'Bollinger Bands 20/2 + %B + bandwidth', 'n=20, sd=2', 'VND / %', 'mid = SMA20; upper/lower = mid +/- 2*stdev(close,20); %B = (close-lower)/(upper-lower); bandwidth% = (upper-lower)/mid*100', 20),
    IND('atr_14', 'ATR 14 (Wilder)', 'n=14, lam mu Wilder', 'VND / %', 'TR = max(high-low, |high-close_truoc|, |low-close_truoc|); ATR = Wilder smoothing 14; atr_pct = ATR/close*100', 15),
    IND('volume_sma_20', 'Trung binh khoi luong 20 phien + ty le khoi luong', 'n=20', 'CP / lan', 'volume_sma_20 = SMA(volume,20); volume_ratio = volume_phien/volume_sma_20', 20),
    IND('roc_5', 'Ty le thay doi gia 5 phien', 'n=5', '%', 'ROC = (close/close_{t-5} - 1)*100', 6),
    IND('roc_20', 'Ty le thay doi gia 20 phien', 'n=20', '%', 'ROC = (close/close_{t-20} - 1)*100', 21),
    IND('roc_60', 'Ty le thay doi gia 60 phien', 'n=60', '%', 'ROC = (close/close_{t-60} - 1)*100', 61),
    IND('ew_return', 'Loi suat trong so deu (equal-weighted) cua vu tru', 'vu tru HOSE, 1 phien', '%', 'EW = trung binh cong % thay doi phien cua cac ma trong vu tru (moi ma 1 phieu) — "co phieu trung binh" di dau', 2),
    IND('cw_ew_spread', 'Chenh lech CW - EW (divergence von hoa vs dong deu)', '1 phien, cung vu tru', 'diem %', 'cw_ew_spread = index_pct - ew_pct; index_pct la % thay doi chinh thuc cua VN-Index, ew_pct la loi suat trong so deu cung phien. Spread > 0 dai han la binh thuong (thien lech small/value cua EW) — chi do lon va dau dang ke (Phu luc I khoi 4).', 2),
  ],
  ratios: [
    RAT('pe_ttm', 'P/E TTM', 'lan', 'P/E = gia dong cua (VND) / EPS TTM (VND/co phieu); chi tinh khi EPS > 0'),
    RAT('pb', 'P/B', 'lan', 'P/B = gia dong cua (VND) / BVPS (VND/co phieu); chi tinh khi BVPS > 0'),
    RAT('roe_ttm', 'ROE TTM', '%', 'ROE = LNST TTM / von chu so huu binh quan (nguon fundamentals)'),
    RAT('roa_ttm', 'ROA TTM', '%', 'ROA = LNST TTM / tong tai san binh quan (nguon fundamentals)'),
    RAT('de_ratio', 'Debt/Equity', 'lan', 'D/E = tong no phai tra / von chu so huu (nguon fundamentals)'),
    RAT('dupont3', 'DuPont 3 thanh to', '%', 'ROE = (LNST/Doanh thu) x (Doanh thu/Tai san binh quan) x (Tai san binh quan/Von chu binh quan); chi phi tai chinh — trang thai: chua mo o ban GD2 nay'),
  ],
  formulas: [
    FOR('flow_sum', 'Tong dong tien rong theo cua so + chuoi phien lien tiep',
      'net = buy_value - sell_value (neu snapshot co truong net thi dung truong net); tong cua so = tong net cua N phien gan nhat; streak = so phien lien tiep cung dau tinh tu phien moi nhat (dung lai o phien net = 0 hoac khac dau)'),
    FOR('concentration', 'Tap trung dong tien nganh (CR3 + HHI)',
      'CR3 = tong |combined_net| cua 3 ma lon nhat / tong |combined_net| toan nganh; HHI = tong binh phuong thi phan |combined_net| (0-1); N_eff = 1/HHI. Cam dung nguong phan loai DOJ cho dong tien.'),
    FOR('breadth', 'Do rong thi truong/nganh',
      'advancers = so ma pct_change > 0; decliners < 0; unchanged = 0; pct_advancers = advancers / tong so ma co du kien gia * 100. Tinh tren vu tru thanh vien HIEN TAI — phong bi khai survivorship bias. Ban nhieu phien: % ma co close > MA20/MA50 tai phien do (mau so = so ma du nen tinh MA tai phien do).'),
    FOR('trend_template_minervini', 'Trend Template (Minervini) — 8 tieu chi, liet ke tung tieu chi, khong gop nhan',
      '1) close > MA150 va MA200. 2) MA150 > MA200. 3) MA200 cao hon MA200 cua 20 phien truoc. 4) MA50 > MA150 va MA200. 5) close > MA50. 6) close >= day 52 tuan * 1,25 (ban 2017; ban 2013 la 1,30 — ban nay khoa 25% theo diem kho phu H5). 7) close >= dinh 52 tuan * 0,75. 8) RS percentile (ROC20 trong vu tru VN tai as_of) >= 70 — thang percentile noi bo, khong phai thang IBD.'),
    FOR('consensus_dispersion', 'Phan tan gia muc tieu dong thuan',
      'Chi tinh khi co >= 3 hang co bao cao trong 12 thang: min/max/trung vi/stdev (mau)/CV = stdev/|trung vi| cua cac gia muc tieu hieu dung moi nhat cua tung hang; upside_median = trung vi/gia hien tai - 1. n < 3: liet ke tung gia muc tieu rieng le, khong tinh phan tan. Chi mo ta phan bo — khong suy ra do tin cay.'),
    FOR('trin_arms', 'TRIN (Arms Index)',
      'TRIN = (Adv/Dec) / (AdvVol/DecVol) — mau so la KHOI LUONG co phieu, khong phai gia tri tien (Arms 1967). Bien the theo GTGD la suy luan ap dung, dat ten rieng TRIN-GTGD, khong dung trong ban nay. Nguong tham chieu SMA10 cua TRIN: 0,80/1,20 (co nguon ghi 0,70 — tranh chap da ghi nhan).'),
    FOR('msci_contribution_approx', 'Dong gop diem chi so (xap xi full-mcap)',
      'contribution cua ma/nganh ~= trong so von hoa DAU phien x loi suat phien. Kho chua co f_i/c_i chinh thuc cua HOSE (QD 714) nen moi so dang nay deu la XAP XI full-mcap — phong bi bat buoc ghi method, cam trinh nhu so san. Khoi dong gop diem CHUA MO o GD2 theo Chot O-2 (lui GD3); du kien von hoa tung ma da co tu screener_history (phu 85% vu tru).'),
    FOR('holder_concentration_partial', 'Co dac so huu (CRk + HHI tung phan)',
      'CRk = tong ty le cua k co dong lon nhat (k = 1/5/10). HHI = tong binh phuong ty le (thang 0-1) tinh TUNG PHAN tren co dong da cong bo — can duoi cua HHI that; bat buoc kem coverage_shares_pct (tong ty le mau tinh) + residual_pct + N_eff = 1/HHI. Cam trinh HHI tung phan nhu HHI toan so, cam chuan hoa mau ve 100%.'),
    FOR('free_float_upper_bound', 'Free float can tren (FTSE-style)',
      'free_float_pct <= 1 - tong ty le cac co dong thuoc nhom han che: lanh dao + nguoi lien quan (dong co position), ca nhan >= 10%, chu the don le >= 30% (2 nguong sau la quy tac co hoc cua he thong). Kho khong thay lock-in con hieu luc va nhom acting-in-concert -> ket qua la CAN TREN, missing: [lock_in_status, concert_parties].'),
    FOR('foreign_room_conventions', 'Room ngoai — 3 quy uoc tach bach (tran theo MA)',
      'fol_max_pct = han muc NN theo MA (CP, bang gia san) / CP luu hanh * 100 — tran da thong bao cua chinh ma theo Dieu 141 ND 155/2020, CAM suy tu nganh. room_cp = max(0, han muc - CP ngoai dang nam); room_pp = fol_max_pct - foreign_owned_pct (so bang gia); room_msci = (fol_max - owned)/fol_max. Nguong tight < 1 diem % la quy uoc cua he thong, khong phai dinh nghia luat.'),
    FOR('holder_change_class', 'Phan loai thay doi co dong giua 2 ky chot',
      'NEW/EXIT/INCREASE/DECREASE/UNCHANGED theo cap (co dong x ma): d_shares (CP), d_pp tinh bang DIEM % (cam % tuong doi tren ty le), d_pct_own_position, d_rank; dating: interval (thay doi xay ra trong khoang 2 moc chot — cam gan ngay cong bo lam ngay giao dich). d_shares = 0 ma d_pp != 0 -> UNCHANGED + passive_dilution_flag (thay doi thu dong do mau so, vd phat hanh them; Dieu 31 TT 96/2020 khong yeu cau cong bo cho thay doi thu dong). 2 ky trung record_date -> dedupe, tinh 1 ky hieu dung.'),
    FOR('leader_laggard_spread', 'Chenh lech nganh dan dau - nganh lui sau (leader-laggard)',
      'loi suat phien cua nganh = binh quan gia quyen von hoa dau phien (w ~ mcap_t/(1+r_i)) cua cac ma thanh vien; leader_laggard_spread_pp = ret nganh cao nhat - ret nganh thap nhat (diem %). Kem sectors_up/sectors_total. Xap xi full-mcap nhu moi so von hoa cua kho.'),
    FOR('compare_fairness', 'Quy tac cong bang du kien khi so sanh',
      'Cung as_of cho ca 2 phia (lech thi lay moc cu hon + ghi chu); cua so chung = GIAO cua 2 phia (phong bi mang common_window {requested, effective, limited_by}); tieu chi chi 1 phia co -> khoi unilateral rieng, cam thay 0/trung vi; chenh so % tinh bang DIEM PHAN TRAM (pp), chenh he so (P/E, P/B) tinh bang LAN, ghi delta.basis; cam gop percentile thanh diem tong; so sanh ma-ma bat buoc kem khoi comparability {same_sector, mcap_ratio, chenh tang truong, chenh ROE} (mcap_ratio chua co du kien von hoa o ban nay).'),
    FOR('rs_percentile', 'RS percentile trong vu tru VN',
      'rs_pct_N = percentile rank (0-100) cua ROC_N cua ma trong toan bo ma co du du kien tai as_of, do publisher Dot C tinh tu ohlcv da publish. Day la thang noi bo cua he thong, khong phai RS Rating cua IBD.'),
    FOR('sector_flow_history', 'Lich su dong tien theo nganh (Dot C)',
      'Publisher tong hop net khoi ngoai/tu doanh theo (nganh ICB cua ma, trade_date) tu history tung ma da publish; sums d5/d20/d60 = tong net N phien gan nhat co du lieu cua nganh.'),
  ],
};
