// js/core/i18n.js — translations, theme, UI mode.
// applyUIMode takes hooks {updateReadGo, renderStats, renderBank, renderPath}
// so core never imports features (wired in main.js, Phase 4).
import { $, esc, store } from './dom.js';
import { state } from './state.js';

export const I18N = {
  en: {
    appName: "Read & Learn", scan: "Scan", progress: "My progress", admin: "Admin",
    snapPage: "Snap a page",
    snapHint: "Take a photo of any English text → tap 🔊 to hear, tap any word for dictionary.",
    takePhoto: "Take photo", gallery: "Gallery", readText: "Read text",
    readGoPhoto: "Read from photo", readGoText: "Process text", readGoIdle: "Create reading",
    readGoNeed: "Take a photo or paste text first",
    pasteText: "Or paste text instead", pastePlaceholder: "Paste English text here…", processText: "Process text",
    tapLearn: "Tap to listen & learn",
    readHint: "🔊 tap sentence to select · tap <b>word</b> = pronunciation + dictionary",
    viewArticleT: "Article view", viewCardsT: "Cards view",
    allLevels: "All levels", noMatch: "No sentences match.",
    stSentences: "Sentences", stLevel: "Level", stDays: "Days", stWords: "Words read",
    profileTitle: "Reading profile", pathTitle: "Learning path", bankTitle: "Sentence bank",
    tapHint: "🔊 hear sentence · tap word = pronunciation + dictionary",
    readingProfile: "Your reading profile",
    learningPath: "Your learning path",
    sentenceBank: "Sentence bank",
    bankHint: "🔊 hear sentence · tap word = pronunciation + dictionary",
    bankEmpty: "Scan some pages and your sentences will appear here.",
    authBrand: "Read & Learn", authTagline: "Your personal English library",
    welcomeBack: "Welcome" ,
    emailPh: "Email address", passPh: "Password (min 4 chars)",
    dobLbl: "Birth date (chooses kid/adult interface)",
    login: "Login", createAccount: "Create account",
    gptWelcomeBack: "Welcome back", gptCreateTitle: "Create your account",
    gptContinue: "Continue", gptNoAccount: "Don't have an account?", gptSignUp: "Sign up",
    gptHaveAccount: "Already have an account?", gptLogIn: "Log in",
    gptTerms: "Terms of Use", gptPrivacy: "Privacy Policy",
    longAudioConfirm: "This article is ~{c} characters (~{m} min of audio) and will use ~{c} ElevenLabs credits. Continue?",
    read: "Read", audio: "Audio", explore: "Explore",
    savedToAudio: "Saved to Audio library",
    audioLibTitle: "Audio library",
    audioLibHint: "Tap \u25B6\uFE0F to replay a saved MP3 \u2014 no ElevenLabs credits used.",
    noAudio: "No saved audio yet. Tap \u25B6\uFE0F on a reading to generate its MP3 and save it here.",
    guestAudioHint: "Saved on this device. Log in to keep them in your cloud library.",
    
    bankEncrypted: "Your sentence bank is encrypted with your password. Server can't read it.",
    lockedTitle: "Locked.", lockedHint: "Your data is still here — enter your password to unlock it.",
    unlockData: "Unlock my data", adminPanel: "Admin panel", logout: "Logout",
    readingRoom: "Reading room", sentencesU: "sentences", wordsU: "words",
    noServerReadings: "No saved readings yet — scan or paste some text and it will appear here.",
    listen: "Listen", open: "Open", delete: "Delete",
    myReadings: "My readings", myReadingsHint: "Articles saved in your account — listen or download anytime.",
    clearScanQ: "Clear this reading (removes it from history)?",
    unlockTitle: "Unlock your data",
    unlockHint: "Your session was restored but your data is encrypted. Enter your password to unlock it.",
    level: "Level", to: "→",
  },
  vi: {
    appName: "Đọc & Học", scan: "Chụp", progress: "Tiến bộ", admin: "Quản trị",
    snapPage: "Chụp một trang",
    snapHint: "Chụp ảnh chữ tiếng Anh → bấm 🔊 để nghe, bấm vào từ để tra từ điển.",
    takePhoto: "Chụp ảnh", gallery: "Thư viện", readText: "Đọc chữ",
    readGoPhoto: "Đọc từ ảnh", readGoText: "Xử lý text", readGoIdle: "Tạo bài đọc",
    readGoNeed: "Chụp ảnh hoặc dán text trước",
    pasteText: "Hoặc dán text thay thế", pastePlaceholder: "Dán đoạn tiếng Anh vào đây…", processText: "Xử lý text",
    tapLearn: "Bấm để nghe & học",
    readHint: "🔊 bấm câu để chọn · bấm <b>từ</b> = phát âm + từ điển",
    viewArticleT: "Xem dạng bài đọc", viewCardsT: "Xem dạng thẻ",
    allLevels: "Mọi trình độ", noMatch: "Không có câu phù hợp.",
    stSentences: "Số câu", stLevel: "Trình độ", stDays: "Số ngày", stWords: "Từ đã đọc",
    profileTitle: "Hồ sơ đọc", pathTitle: "Lộ trình học", bankTitle: "Kho câu",
    tapHint: "🔊 nghe câu · bấm vào từ = phát âm + từ điển",
    readingProfile: "Hồ sơ đọc của bạn",
    learningPath: "Lộ trình học",
    sentenceBank: "Kho câu",
    bankHint: "🔊 nghe câu · bấm vào từ = phát âm + từ điển",
    bankEmpty: "Chụp vài trang, câu của bạn sẽ hiện ở đây.",
    authBrand: "Đọc & Học", authTagline: "Thư viện tiếng Anh của bạn",
    welcomeBack: "Chào mừng", 
    emailPh: "Địa chỉ email", passPh: "Mật khẩu (tối thiểu 4 ký tự)",
    dobLbl: "Ngày sinh (chọn giao diện trẻ em/người lớn)",
    login: "Đăng nhập", createAccount: "Tạo tài khoản",
    gptWelcomeBack: "Chào mừng trở lại", gptCreateTitle: "Tạo tài khoản của bạn",
    gptContinue: "Tiếp tục", gptNoAccount: "Chưa có tài khoản?", gptSignUp: "Đăng ký",
    gptHaveAccount: "Đã có tài khoản?", gptLogIn: "Đăng nhập",
    gptTerms: "Điều khoản sử dụng", gptPrivacy: "Chính sách riêng tư",
    longAudioConfirm: "Bài này khoảng {c} ký tự (~{m} phút audio), sẽ tốn ~{c} credits ElevenLabs. Tiếp tục tạo?",
    read: "\u0110\u1ECDc", audio: "Nghe l\u1EA1i", explore: "Kh\u00E1m ph\u00E1",
    savedToAudio: "\u0110\u00E3 l\u01B0u v\u00E0o th\u01B0 vi\u1EC7n Nghe l\u1EA1i",
    audioLibTitle: "Th\u01B0 vi\u1EC7n nghe l\u1EA1i",
    audioLibHint: "B\u1EA5m \u25B6\uFE0F \u0111\u1EC3 nghe l\u1EA1i MP3 \u0111\u00E3 l\u01B0u \u2014 kh\u00F4ng t\u1ED1n credits ElevenLabs.",
    noAudio: "Ch\u01B0a c\u00F3 audio n\u00E0o. B\u1EA5m \u25B6\uFE0F \u1EDF b\u00E0i \u0111\u1ECDc \u0111\u1EC3 t\u1EA1o MP3 v\u00E0 l\u01B0u v\u00E0o \u0111\u00E2y.",
    guestAudioHint: "L\u01B0u tr\u00EAn m\u00E1y n\u00E0y. \u0110\u0103ng nh\u1EADp \u0111\u1EC3 l\u01B0u l\u00EAn th\u01B0 vi\u1EC7n \u0111\u00E1m m\u00E2y.",
    
    bankEncrypted: "Kho câu của bạn được mã hoá bằng mật khẩu. Server không đọc được.",
    lockedTitle: "Đã khoá.", lockedHint: "Dữ liệu vẫn còn đây — nhập mật khẩu để mở khoá.",
    unlockData: "Mở khoá dữ liệu", adminPanel: "Bảng quản trị", logout: "Đăng xuất",
    readingRoom: "Góc đọc sách", sentencesU: "câu", wordsU: "từ",
    noServerReadings: "Chưa có bài nào — quét hoặc dán text, bài sẽ tự lưu ở đây.",
    listen: "Nghe", open: "Mở", delete: "Xoá",
    myReadings: "Bài đọc của tôi", myReadingsHint: "Các bài đã lưu trong tài khoản — nghe hoặc tải về bất cứ lúc nào.",
    clearScanQ: "Xoá bài đọc này (xoá khỏi lịch sử)?",
    unlockTitle: "Mở khoá dữ liệu",
    unlockHint: "Phiên đăng nhập đã khôi phục nhưng dữ liệu được mã hoá. Nhập mật khẩu để mở khoá.",
    level: "Cấp", to: "→",
  }
};
export const KID_LEVELS = [
  {cefr:"A1", icon:"🌱", vi:"Mầm", en:"Sprout"},
  {cefr:"A2", icon:"🌿", vi:"Chồi", en:"Seedling"},
  {cefr:"B1", icon:"🌳", vi:"Cây", en:"Tree"},
  {cefr:"B2", icon:"⭐", vi:"Ngôi sao", en:"Star"},
  {cefr:"C1", icon:"💎", vi:"Kim cương", en:"Diamond"},
  {cefr:"C2", icon:"👑", vi:"Vua", en:"Master"},
];
export function kidLevel(cefr){
  return KID_LEVELS.find(k=>k.cefr===cefr) || KID_LEVELS[2];
}
export function t(key){
  return (I18N[state.uiLang] && I18N[state.uiLang][key]) || I18N.en[key] || key;
}
export function levelLabel(cefr){
  if(state.uiMode === "kid"){
    const k = kidLevel(cefr);
    return `${k.icon} ${state.uiLang==="vi"?k.vi:k.en}`;
  }
  return cefr;
}
export function setLang(l, hooks={}){
  state.uiLang = l;
  store.set("uiLang", state.uiLang); store.set("uiLangSet", true);
  $("langBtn").textContent = state.uiLang.toUpperCase();
  applyUIMode(hooks);
  document.querySelectorAll(".langBtn").forEach(x=>{
    x.classList.toggle("primary", x.dataset.lang===state.uiLang);
    x.classList.toggle("ghost", x.dataset.lang!==state.uiLang);
  });
}
export function applyTheme(){
  const dark = store.get("elab_theme","light")==="dark";
  document.body.classList.toggle("dark", dark);
  $("themeBtn").innerHTML = `<svg class="ic"><use href="#${dark ? "i-sun" : "i-moon"}"/></svg>`;
}
export function applyUIMode(hooks={}){
  document.body.classList.toggle("kid-mode", state.uiMode==="kid");
  $("mascot").style.display = state.uiMode==="kid" ? "" : "none";
  document.querySelector("header h1").innerHTML = '<svg class="ic ic-h"><use href="#i-camera"/></svg> '+esc(t("appName"));

  $("menuTitleLbl").textContent = t("explore");
  $("menuRead").textContent = t("read");
  $("menuAudio").textContent = t("audio");
  $("menuBooks").textContent = state.uiLang==="vi" ? "S\u00E1ch" : "Books";
  $("menuProgress").textContent = t("progress");
  $("audioLibTitle").textContent = t("audioLibTitle");

  $("snapTitleLbl").textContent = t("snapPage");
  $("snapHint").innerHTML = t("snapHint");
  $("readCameraLbl").textContent = t("takePhoto");
  $("readGalleryLbl").textContent = t("gallery");
  (hooks.updateReadGo||(()=>{}))();
  $("pasteLblTxt").textContent = t("pasteText");
  $("readTextInput").placeholder = t("pastePlaceholder");
  $("readResultTitleLbl").textContent = t("tapLearn");
  $("srvReadTitle").textContent = t("myReadings");
  $("srvReadHint").textContent = t("myReadingsHint");
  $("readResultHint").innerHTML = t("readHint");
  $("viewArticle").title = t("viewArticleT");
  $("viewCards").title = t("viewCardsT");
  $("stSentLbl").textContent = t("stSentences");
  $("stLevelLbl").textContent = t("stLevel");
  $("stDaysLbl").textContent = t("stDays");
  $("stWordsLbl").textContent = t("stWords");
  $("profileTitle").textContent = t("profileTitle");
  $("pathTitle").textContent = t("pathTitle");
  $("bankTitle").textContent = t("bankTitle");
  $("unlockTitle").textContent = t("unlockTitle");
  $("unlockHint").textContent = t("unlockHint");
  (hooks.renderStats||(()=>{}))(); (hooks.renderBank||(()=>{}))(); (hooks.renderPath||(()=>{}))();
}

