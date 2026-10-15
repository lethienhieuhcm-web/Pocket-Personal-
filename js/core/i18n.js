// js/core/i18n.js — translations, theme, UI mode.
// applyUIMode takes hooks {updateReadGo, renderStats, renderBank, renderPath}
// so core never imports features (wired in main.js, Phase 4).
import { $, esc, store } from './dom.js';
import { state } from './state.js';

export const LANGS = ["en", "vi", "zh", "ko"];
export const LANG_LABELS = { en: "EN", vi: "VI", zh: "中文", ko: "한국어" };

export const I18N = {
  en: {
    appName: "Read & Learn", scan: "Scan", progress: "My progress", admin: "Admin",
    snapPage: "Snap a page",
    snapHint: "Take a photo of any English text → tap <svg class=\"ic\" style=\"width:16px;height:16px;vertical-align:-3px\"><use href=\"#i-volume\"/></svg> to hear, tap any word for dictionary.",
    takePhoto: "Take photo", gallery: "Gallery", readText: "Read text",
    readGoPhoto: "Read from photo", readGoText: "Process text", readGoIdle: "Create reading",
    readGoNeed: "Take a photo or paste text first",
    pasteText: "Or paste text instead", pastePlaceholder: "Paste English text here…", processText: "Process text",
    tapLearn: "Tap to listen & learn",
    readHint: "<svg class=\"ic\" style=\"width:16px;height:16px;vertical-align:-3px\"><use href=\"#i-volume\"/></svg> tap sentence to select · tap <b>word</b> = pronunciation + dictionary",
    viewArticleT: "Article view", viewCardsT: "Cards view",
    allLevels: "All levels", noMatch: "No sentences match.",
    stSentences: "Sentences", stLevel: "Level", stDays: "Days", stWords: "Words read",
    profileTitle: "Reading profile",
    userProfileTitle: "Profile", pathTitle: "Learning path", bankTitle: "Sentence bank",
    tapHint: "<svg class=\"ic\" style=\"width:16px;height:16px;vertical-align:-3px\"><use href=\"#i-volume\"/></svg> hear sentence · tap word = pronunciation + dictionary",
    readingProfile: "Your reading profile",
    learningPath: "Your learning path",
    sentenceBank: "Sentence bank",
    bankHint: "<svg class=\"ic\" style=\"width:16px;height:16px;vertical-align:-3px\"><use href=\"#i-volume\"/></svg> hear sentence · tap word = pronunciation + dictionary",
    bankEmpty: "Scan some pages and your sentences will appear here.",
    aiExplain: "AI explain",
    vocabReview: "Review words",
    vocabReviewTitle: "Review vocabulary",
    library_title: "Library",
    home_library: "Library",
    home_library_d: "Curated lessons by topic",
    libraryEmpty: "No collections yet.",
    back: "Back",
    vocabStartBtn: "Start review",
    vocabEmpty: "No words due for review. Look up words to add them.",
    vocabDone: "Done! All words reviewed.",
    vocabFlip: "Show meaning",
    vocabForgot: "Forgot",
    vocabRemembered: "Remembered",
    authBrand: "Read & Learn", authTagline: "Your personal English library",
    welcomeBack: "Welcome" ,
    emailPh: "Email address", passPh: "Password (min 4 chars)",
    dobLbl: "Birth date (chooses kid/adult interface)",
    login: "Login", createAccount: "Create account",
    gptWelcomeBack: "Welcome back", gptCreateTitle: "Create your account",
    gptContinue: "Continue", gptNoAccount: "Don't have an account?", gptSignUp: "Sign up",
    gptHaveAccount: "Already have an account?", gptLogIn: "Log in",
    gptTerms: "Terms of Use", gptPrivacy: "Privacy Policy",
    longAudioConfirm: "This article is ~{c} characters (~{m} min of audio) and will use ~{c} audio credits. Continue?",
    read: "Read", audio: "Audio", explore: "Explore", books: "Books",
    savedToAudio: "Saved to Audio library",
    audioLibTitle: "Audio library",
    audioLibHint: "Tap <svg class=\"ic\" style=\"width:14px;height:14px;vertical-align:-2px\"><use href=\"#i-play\"/></svg> to replay a saved MP3 \u2014 no audio credits used.",
    bookTitlePh: "Book title…", uploadBtn: "Upload", cancel: "Cancel", uploading: "Uploading…", uploadedProcessing: "Uploaded! Processing…",
    noAudio: "No saved audio yet. Tap <svg class=\"ic\" style=\"width:14px;height:14px;vertical-align:-2px\"><use href=\"#i-play\"/></svg> on a reading to generate its MP3 and save it here.",
    guestAudioHint: "Saved on this device. Log in to keep them in your cloud library.",

    bankEncrypted: "Your sentence bank is protected by your password. We can't read it.",
    lockedTitle: "Locked.", lockedHint: "Your data is still here — enter your password to unlock it.",
    unlockData: "Unlock my data", adminPanel: "Admin panel", logout: "Logout",
    home_admin: "Admin", home_admin_d: "User management", limitReached: "Limit reached",
    readingRoom: "Reading room", sentencesU: "sentences", wordsU: "words",
    noServerReadings: "No saved readings yet — scan or paste some text and it will appear here.",
    listen: "Listen", open: "Open", delete: "Delete", confirmYes: "Yes", confirmNo: "No",
    myReadings: "My readings", myReadingsHint: "Articles saved in your account — listen or download anytime.",
    clearScanQ: "Clear this reading (removes it from history)?",
    confirmPlanSet: "Set {email} to {plan}?",
    confirmDeleteUser: "Delete {user}?",
    confirmClearBank: "Clear the entire sentence bank?",
    unlockTitle: "Unlock your data",
    unlockHint: "Your session was restored but your data is locked. Enter your password to unlock it.",
    level: "Level", to: "→",
  },
  vi: {
    appName: "Đọc & Học", scan: "Chụp", progress: "Tiến bộ", admin: "Quản trị",
    snapPage: "Chụp một trang",
    snapHint: "Chụp ảnh chữ tiếng Anh → bấm <svg class=\"ic\" style=\"width:16px;height:16px;vertical-align:-3px\"><use href=\"#i-volume\"/></svg> để nghe, bấm vào từ để tra từ điển.",
    takePhoto: "Chụp ảnh", gallery: "Thư viện", readText: "Đọc chữ",
    readGoPhoto: "Đọc từ ảnh", readGoText: "Xử lý text", readGoIdle: "Tạo bài đọc",
    readGoNeed: "Chụp ảnh hoặc dán text trước",
    pasteText: "Hoặc dán text thay thế", pastePlaceholder: "Dán đoạn tiếng Anh vào đây…", processText: "Xử lý text",
    tapLearn: "Bấm để nghe & học",
    readHint: "<svg class=\"ic\" style=\"width:16px;height:16px;vertical-align:-3px\"><use href=\"#i-volume\"/></svg> bấm câu để chọn · bấm <b>từ</b> = phát âm + từ điển",
    viewArticleT: "Xem dạng bài đọc", viewCardsT: "Xem dạng thẻ",
    allLevels: "Mọi trình độ", noMatch: "Không có câu phù hợp.",
    stSentences: "Số câu", stLevel: "Trình độ", stDays: "Số ngày", stWords: "Từ đã đọc",
    profileTitle: "Hồ sơ đọc",
    userProfileTitle: "Hồ sơ", pathTitle: "Lộ trình học", bankTitle: "Kho câu",
    tapHint: "<svg class=\"ic\" style=\"width:16px;height:16px;vertical-align:-3px\"><use href=\"#i-volume\"/></svg> nghe câu · bấm vào từ = phát âm + từ điển",
    readingProfile: "Hồ sơ đọc của bạn",
    learningPath: "Lộ trình học",
    sentenceBank: "Kho câu",
    bankHint: "<svg class=\"ic\" style=\"width:16px;height:16px;vertical-align:-3px\"><use href=\"#i-volume\"/></svg> nghe câu · bấm vào từ = phát âm + từ điển",
    bankEmpty: "Chụp vài trang, câu của bạn sẽ hiện ở đây.",
    aiExplain: "AI giải thích",
    vocabReview: "Ôn từ vựng",
    vocabReviewTitle: "Ôn từ vựng",
    library_title: "Thư viện",
    home_library: "Thư viện",
    home_library_d: "Bài học curated theo chủ đề",
    libraryEmpty: "Chưa có bộ sưu tập nào.",
    back: "Quay lại",
    vocabStartBtn: "Bắt đầu ôn",
    vocabEmpty: "Chưa có từ nào đến hạn ôn. Tra từ để thêm vào.",
    vocabDone: "Xong! Đã ôn hết từ.",
    vocabFlip: "Xem nghĩa",
    vocabForgot: "Quên",
    vocabRemembered: "Nhớ",
    authBrand: "Đọc & Học", authTagline: "Thư viện tiếng Anh của bạn",
    welcomeBack: "Chào mừng",
    emailPh: "Địa chỉ email", passPh: "Mật khẩu (tối thiểu 4 ký tự)",
    dobLbl: "Ngày sinh (chọn giao diện trẻ em/người lớn)",
    login: "Đăng nhập", createAccount: "Tạo tài khoản",
    gptWelcomeBack: "Chào mừng trở lại", gptCreateTitle: "Tạo tài khoản của bạn",
    gptContinue: "Tiếp tục", gptNoAccount: "Chưa có tài khoản?", gptSignUp: "Đăng ký",
    gptHaveAccount: "Đã có tài khoản?", gptLogIn: "Đăng nhập",
    gptTerms: "Điều khoản sử dụng", gptPrivacy: "Chính sách riêng tư",
    longAudioConfirm: "Bài này khoảng {c} ký tự (~{m} phút audio), sẽ dùng ~{c} credits âm thanh. Tiếp tục tạo?",
    read: "\u0110\u1ECDc", audio: "Nghe l\u1EA1i", explore: "Kh\u00E1m ph\u00E1", books: "S\u00E1ch",
    savedToAudio: "\u0110\u00E3 l\u01B0u v\u00E0o th\u01B0 vi\u1EC7n Nghe l\u1EA1i",
    audioLibTitle: "Th\u01B0 vi\u1EC7n nghe l\u1EA1i",
    audioLibHint: "B\u1EA5m <svg class=\"ic\" style=\"width:14px;height:14px;vertical-align:-2px\"><use href=\"#i-play\"/></svg> \u0111\u1EC3 nghe l\u1EA1i MP3 \u0111\u00E3 l\u01B0u \u2014 kh\u00F4ng t\u1ED1n credits \u00E2m thanh.",
    bookTitlePh: "T\u00EAn s\u00E1ch\u2026", uploadBtn: "T\u1EA3i l\u00EAn", cancel: "Hu\u1EF7", uploading: "\u0110ang t\u1EA3i\u2026", uploadedProcessing: "\u0110\u00E3 t\u1EA3i! \u0110ang x\u1EED l\u00FD\u2026",
    noAudio: "Ch\u01B0a c\u00F3 audio n\u00E0o. B\u1EA5m <svg class=\"ic\" style=\"width:14px;height:14px;vertical-align:-2px\"><use href=\"#i-play\"/></svg> \u1EDF b\u00E0i \u0111\u1ECDc \u0111\u1EC3 t\u1EA1o MP3 v\u00E0 l\u01B0u v\u00E0o \u0111\u00E2y.",
    guestAudioHint: "L\u01B0u tr\u00EAn m\u00E1y n\u00E0y. \u0110\u0103ng nh\u1EADp \u0111\u1EC3 l\u01B0u l\u00EAn th\u01B0 vi\u1EC7n \u0111\u00E1m m\u00E2y.",

    bankEncrypted: "Kho c\u00E2u c\u1EE7a b\u1EA1n \u0111\u01B0\u1EE3c b\u1EA3o v\u1EC7 b\u1EB1ng m\u1EADt kh\u1EA9u. Ch\u00FAng t\u00F4i kh\u00F4ng \u0111\u1ECDc \u0111\u01B0\u1EE3c.",
    lockedTitle: "\u0110\u00E3 kho\u00E1.", lockedHint: "D\u1EEF li\u1EC7u v\u1EABn c\u00F2n \u0111\u00E2y \u2014 nh\u1EADp m\u1EADt kh\u1EA9u \u0111\u1EC3 m\u1EDF kho\u00E1.",
    unlockData: "M\u1EDF kho\u00E1 d\u1EEF li\u1EC7u", adminPanel: "B\u1EA3ng qu\u1EA3n tr\u1ECB", logout: "\u0110\u0103ng xu\u1EA5t",
    home_admin: "Qu\u1EA3n tr\u1ECB", home_admin_d: "Qu\u1EA3n l\u00FD ng\u01B0\u1EDDi d\u00F9ng", limitReached: "\u0110\u00E3 \u0111\u1EA1t gi\u1EDBi h\u1EA1n",
    readingRoom: "G\u00F3c \u0111\u1ECDc s\u00E1ch", sentencesU: "c\u00E2u", wordsU: "t\u1EEB",
    noServerReadings: "Ch\u01B0a c\u00F3 b\u00E0i n\u00E0o \u2014 qu\u00E9t ho\u1EB7c d\u00E1n text, b\u00E0i s\u1EBD t\u1EF1 l\u01B0u \u1EDF \u0111\u00E2y.",
    listen: "Nghe", open: "M\u1EDF", delete: "Xo\u00E1", confirmYes: "\u0110\u1ED3ng \u00FD", confirmNo: "H\u1EE7y",
    myReadings: "B\u00E0i \u0111\u1ECDc c\u1EE7a t\u00F4i", myReadingsHint: "C\u00E1c b\u00E0i \u0111\u00E3 l\u01B0u trong t\u00E0i kho\u1EA3n \u2014 nghe ho\u1EB7c t\u1EA3i v\u1EC1 b\u1EA5t c\u1EE9 l\u00FAc n\u00E0o.",
    clearScanQ: "Xo\u00E1 b\u00E0i \u0111\u1ECDc n\u00E0y (xo\u00E1 kh\u1ECFi l\u1ECBch s\u1EED)?",
    confirmPlanSet: "\u0110\u1EB7t {email} th\u00E0nh {plan}?",
    confirmDeleteUser: "Xo\u00E1 {user}?",
    confirmClearBank: "Xo\u00E1 to\u00E0n b\u1ED9 s\u1ED5 c\u00E2u?",
    unlockTitle: "M\u1EDF kho\u00E1 d\u1EEF li\u1EC7u",
    unlockHint: "Phi\u00EAn \u0111\u0103ng nh\u1EADp \u0111\u00E3 kh\u00F4i ph\u1EE5c nh\u01B0ng d\u1EEF li\u1EC7u \u0111ang b\u1ECB kho\u00E1. Nh\u1EADp m\u1EADt kh\u1EA9u \u0111\u1EC3 m\u1EDF kho\u00E1.",
    level: "C\u1EA5p", to: "→",
  },
  zh: {
    appName: "阅读与学习", scan: "扫描", progress: "我的进度", admin: "管理",
    snapPage: "拍摄一页",
    snapHint: "拍摄任何英文文本 → 点击 <svg class=\"ic\" style=\"width:16px;height:16px;vertical-align:-3px\"><use href=\"#i-volume\"/></svg> 收听，点击单词查词典。",
    takePhoto: "拍照", gallery: "相册", readText: "读取文本",
    readGoPhoto: "从照片读取", readGoText: "处理文本", readGoIdle: "创建阅读",
    readGoNeed: "请先拍照或粘贴文本",
    pasteText: "或粘贴文本", pastePlaceholder: "在此粘贴英文文本…", processText: "处理文本",
    tapLearn: "点击收听和学习",
    readHint: "<svg class=\"ic\" style=\"width:16px;height:16px;vertical-align:-3px\"><use href=\"#i-volume\"/></svg> 点击句子选择 · 点击 <b>单词</b> = 发音 + 词典",
    viewArticleT: "文章视图", viewCardsT: "卡片视图",
    allLevels: "所有级别", noMatch: "没有匹配的句子。",
    stSentences: "句子", stLevel: "级别", stDays: "天数", stWords: "已读单词",
    profileTitle: "阅读档案",
    userProfileTitle: "个人资料", pathTitle: "学习路径", bankTitle: "句子库",
    tapHint: "<svg class=\"ic\" style=\"width:16px;height:16px;vertical-align:-3px\"><use href=\"#i-volume\"/></svg> 收听句子 · 点击单词 = 发音 + 词典",
    readingProfile: "你的阅读档案",
    learningPath: "你的学习路径",
    sentenceBank: "句子库",
    bankHint: "<svg class=\"ic\" style=\"width:16px;height:16px;vertical-align:-3px\"><use href=\"#i-volume\"/></svg> 收听句子 · 点击单词 = 发音 + 词典",
    bankEmpty: "扫描几页，你的句子就会出现在这里。",
    aiExplain: "AI解释",
    vocabReview: "复习单词",
    vocabReviewTitle: "复习词汇",
    library_title: "图书馆",
    home_library: "图书馆",
    home_library_d: "按主题精选课程",
    libraryEmpty: "还没有合集。",
    back: "返回",
    vocabStartBtn: "开始复习",
    vocabEmpty: "没有要复习的单词。查词以添加。",
    vocabDone: "完成！已复习完所有单词。",
    vocabFlip: "显示含义",
    vocabForgot: "忘记",
    vocabRemembered: "记住",
    authBrand: "阅读与学习", authTagline: "你的个人英语图书馆",
    welcomeBack: "欢迎",
    emailPh: "电子邮箱", passPh: "密码（至少4个字符）",
    dobLbl: "出生日期（选择儿童/成人界面）",
    login: "登录", createAccount: "创建账户",
    gptWelcomeBack: "欢迎回来", gptCreateTitle: "创建你的账户",
    gptContinue: "继续", gptNoAccount: "还没有账户？", gptSignUp: "注册",
    gptHaveAccount: "已有账户？", gptLogIn: "登录",
    gptTerms: "使用条款", gptPrivacy: "隐私政策",
    longAudioConfirm: "本文约 {c} 个字符（约 {m} 分钟音频），将使用约 {c} 音频额度。继续吗？",
    read: "阅读", audio: "音频", explore: "探索", books: "书籍",
    savedToAudio: "已保存到音频库",
    audioLibTitle: "音频库",
    audioLibHint: "点击 <svg class=\"ic\" style=\"width:14px;height:14px;vertical-align:-2px\"><use href=\"#i-play\"/></svg> 重播已保存的 MP3 \u2014 不消耗音频额度。",
    bookTitlePh: "书名…", uploadBtn: "上传", cancel: "取消", uploading: "上传中…", uploadedProcessing: "已上传！处理中…",
    noAudio: "还没有保存的音频。点击阅读中的 <svg class=\"ic\" style=\"width:14px;height:14px;vertical-align:-2px\"><use href=\"#i-play\"/></svg> 生成 MP3 并保存在这里。",
    guestAudioHint: "保存在此设备上。登录后可保存到云端文库。",

    bankEncrypted: "你的句子库受密码保护。我们无法读取。",
    lockedTitle: "已锁定。", lockedHint: "你的数据还在 — 输入密码解锁。",
    unlockData: "解锁我的数据", adminPanel: "管理面板", logout: "退出登录",
    home_admin: "管理", home_admin_d: "用户管理", limitReached: "已达到上限",
    readingRoom: "阅读室", sentencesU: "句", wordsU: "词",
    noServerReadings: "还没有保存的阅读 — 扫描或粘贴文本，它会出现在这里。",
    listen: "收听", open: "打开", delete: "删除", confirmYes: "确定", confirmNo: "取消",
    myReadings: "我的阅读", myReadingsHint: "保存在你账户中的文章 — 随时收听或下载。",
    clearScanQ: "清除这篇阅读（从历史记录中删除）？",
    confirmPlanSet: "将 {email} 设为 {plan}？",
    confirmDeleteUser: "删除 {user}？",
    confirmClearBank: "清空整个句子库？",
    unlockTitle: "解锁你的数据",
    unlockHint: "会话已恢复，但数据已锁定。输入密码解锁。",
    level: "级别", to: "→",
  },
  ko: {
    appName: "읽기 & 학습", scan: "스캔", progress: "나의 진도", admin: "관리",
    snapPage: "페이지 촬영",
    snapHint: "영어 텍스트를 사진으로 찍으세요 → <svg class=\"ic\" style=\"width:16px;height:16px;vertical-align:-3px\"><use href=\"#i-volume\"/></svg>를 눌러 듣고, 단어를 눌러 사전을 확인하세요.",
    takePhoto: "사진 찍기", gallery: "갤러리", readText: "텍스트 읽기",
    readGoPhoto: "사진에서 읽기", readGoText: "텍스트 처리", readGoIdle: "읽기 자료 만들기",
    readGoNeed: "먼저 사진을 찍거나 텍스트를 붙여넣으세요",
    pasteText: "또는 텍스트 붙여넣기", pastePlaceholder: "여기에 영어 텍스트를 붙여넣으세요…", processText: "텍스트 처리",
    tapLearn: "눌러서 듣고 학습하기",
    readHint: "<svg class=\"ic\" style=\"width:16px;height:16px;vertical-align:-3px\"><use href=\"#i-volume\"/></svg> 문장을 눌러 선택 · <b>단어</b> 누르기 = 발음 + 사전",
    viewArticleT: "아티클 보기", viewCardsT: "카드 보기",
    allLevels: "모든 레벨", noMatch: "일치하는 문장이 없습니다.",
    stSentences: "문장", stLevel: "레벨", stDays: "일수", stWords: "읽은 단어",
    profileTitle: "읽기 프로필",
    userProfileTitle: "프로필", pathTitle: "학습 경로", bankTitle: "문장 보관함",
    tapHint: "<svg class=\"ic\" style=\"width:16px;height:16px;vertical-align:-3px\"><use href=\"#i-volume\"/></svg> 문장 듣기 · 단어 누르기 = 발음 + 사전",
    readingProfile: "나의 읽기 프로필",
    learningPath: "나의 학습 경로",
    sentenceBank: "문장 보관함",
    bankHint: "<svg class=\"ic\" style=\"width:16px;height:16px;vertical-align:-3px\"><use href=\"#i-volume\"/></svg> 문장 듣기 · 단어 누르기 = 발음 + 사전",
    bankEmpty: "페이지를 몇 장 스캔하면 문장이 여기에 표시됩니다.",
    aiExplain: "AI 설명",
    vocabReview: "단어 복습",
    vocabReviewTitle: "어휘 복습",
    library_title: "라이브러리",
    home_library: "라이브러리",
    home_library_d: "주제별 큐레이션 레슨",
    libraryEmpty: "컬렉션이 없습니다.",
    back: "뒤로",
    vocabStartBtn: "복습 시작",
    vocabEmpty: "복습할 단어가 없습니다. 단어를 찾아 추가하세요.",
    vocabDone: "완료! 모든 단어를 복습했습니다.",
    vocabFlip: "뜻 보기",
    vocabForgot: "모름",
    vocabRemembered: "암",
    authBrand: "읽기 & 학습", authTagline: "나만의 영어 도서관",
    welcomeBack: "환영합니다",
    emailPh: "이메일 주소", passPh: "비밀번호 (4자 이상)",
    dobLbl: "생년월일 (어린이/성인 인터페이스 선택)",
    login: "로그인", createAccount: "계정 만들기",
    gptWelcomeBack: "다시 오신 것을 환영합니다", gptCreateTitle: "계정 만들기",
    gptContinue: "계속", gptNoAccount: "계정이 없으신가요?", gptSignUp: "가입하기",
    gptHaveAccount: "이미 계정이 있으신가요?", gptLogIn: "로그인",
    gptTerms: "이용약관", gptPrivacy: "개인정보처리방침",
    longAudioConfirm: "이 글은 약 {c}자(약 {m}분 분량의 오디오)이며 오디오 크레딧 {c}이 사용됩니다. 계속하시겠습니까?",
    read: "읽기", audio: "오디오", explore: "탐색", books: "도서",
    savedToAudio: "오디오 라이브러리에 저장됨",
    audioLibTitle: "오디오 라이브러리",
    audioLibHint: "<svg class=\"ic\" style=\"width:14px;height:14px;vertical-align:-2px\"><use href=\"#i-play\"/></svg>를 눌러 저장된 MP3를 다시 재생하세요 \u2014 오디오 크레딧이 사용되지 않습니다.",
    bookTitlePh: "책 제목…", uploadBtn: "업로드", cancel: "취소", uploading: "업로드 중…", uploadedProcessing: "업로드됨! 처리 중…",
    noAudio: "저장된 오디오가 없습니다. 읽기 자료에서 <svg class=\"ic\" style=\"width:14px;height:14px;vertical-align:-2px\"><use href=\"#i-play\"/></svg>를 눌러 MP3를 생성하고 여기에 저장하세요.",
    guestAudioHint: "이 기기에 저장됩니다. 로그인하면 클라우드 라이브러리에 보관됩니다.",

    bankEncrypted: "문장 보관함은 비밀번호로 보호됩니다. 저희는 읽을 수 없습니다.",
    lockedTitle: "잠김.", lockedHint: "데이터는 그대로 있습니다 — 비밀번호를 입력하여 잠금을 해제하세요.",
    unlockData: "내 데이터 잠금 해제", adminPanel: "관리 패널", logout: "로그아웃",
    home_admin: "관리", home_admin_d: "사용자 관리", limitReached: "한도에 도달했습니다",
    readingRoom: "읽기방", sentencesU: "문장", wordsU: "단어",
    noServerReadings: "저장된 읽기 자료가 없습니다 — 텍스트를 스캔하거나 붙여넣으면 여기에 표시됩니다.",
    listen: "듣기", open: "열기", delete: "삭제", confirmYes: "확인", confirmNo: "취소",
    myReadings: "나의 읽기 자료", myReadingsHint: "계정에 저장된 아티클 — 언제든지 듣거나 다운로드하세요.",
    clearScanQ: "이 읽기 자료를 지우시겠습니까 (기록에서 삭제)?",
    confirmPlanSet: "{email}님을 {plan}으로 설정하시겠습니까?",
    confirmDeleteUser: "{user}님을 삭제하시겠습니까?",
    confirmClearBank: "문장 은행 전체를 비우시겠습니까?",
    unlockTitle: "데이터 잠금 해제",
    unlockHint: "세션이 복원되었지만 데이터가 잠겨 있습니다. 비밀번호를 입력하여 잠금을 해제하세요.",
    level: "레벨", to: "→",
  }
};
export const KID_LEVELS = [
  {cefr:"A1", vi:"Mầm", en:"Sprout", zh:"幼苗", ko:"새싹"},
  {cefr:"A2", vi:"Chồi", en:"Seedling", zh:"小苗", ko:"모종"},
  {cefr:"B1", vi:"Cây", en:"Tree", zh:"大树", ko:"나무"},
  {cefr:"B2", vi:"Ngôi sao", en:"Star", zh:"星星", ko:"별"},
  {cefr:"C1", vi:"Kim cương", en:"Diamond", zh:"钻石", ko:"다이아몬드"},
  {cefr:"C2", vi:"Vua", en:"Master", zh:"大师", ko:"달인"},
];
export function kidLevel(cefr){
  return KID_LEVELS.find(k=>k.cefr===cefr) || KID_LEVELS[2];
}
export function t(key){
  return (I18N[state.uiLang] && I18N[state.uiLang][key]) || I18N.en[key] || key;
}
export function kidLevelName(cefr){
  const k = kidLevel(cefr);
  return k[state.uiLang]||k.en;
}
export function levelLabel(cefr){
  if(state.uiMode === "kid") return kidLevelName(cefr);
  return cefr;
}
export function setLang(l, hooks={}){
  state.uiLang = l;
  // Một key duy nhất "elab_uiLang", chuỗi thường (RULES.md 8). Key cũ "uiLang"
  // (JSON-quoted) và "uiLangSet" (chỉ ghi không đọc) bỏ (Chốt 2026-10-11).
  try{ localStorage.setItem("elab_uiLang", l); }catch(e){}
  const lb = $("langBtn");
  if(lb) lb.textContent = (LANG_LABELS[state.uiLang]||state.uiLang.toUpperCase());
  applyStaticI18n();
  applyUIMode(hooks);
  document.querySelectorAll(".langBtn").forEach(x=>{
    x.classList.toggle("primary", x.dataset.lang===state.uiLang);
    x.classList.toggle("ghost", x.dataset.lang!==state.uiLang);
  });
}
// Quét dict vào các phần tử tĩnh [data-i18n]/[data-i18n-ph] của shell.
// Dict inline (index.html) mới là bản đầy đủ cho shell — dict module thiếu nhiều
// key shell (home_scan, app_title...) vì nó chỉ phục vụ nội dung động qua t().
// Nên module ủy quyền cho hàm quét của shell khi có (Chốt 2026-10-11).
export function applyStaticI18n(){
  if(typeof window !== "undefined" && typeof window.__elabApplyShellLang === "function"){
    try{ window.__elabApplyShellLang(state.uiLang); return; }catch(e){}
  }
  const d = I18N[state.uiLang] || I18N.en;
  document.querySelectorAll("[data-i18n]").forEach(el=>{
    const k = el.getAttribute("data-i18n");
    if(d[k]) el.textContent = d[k];
  });
  document.querySelectorAll("[data-i18n-ph]").forEach(el=>{
    const k = el.getAttribute("data-i18n-ph");
    if(d[k]) el.placeholder = d[k];
  });
  document.documentElement.lang = state.uiLang;
}
// Nút đổi ngôn ngữ ở shell (index.html) gọi hàm này khi module đã load.
if(typeof window !== "undefined") window.__elabCycleLang = function(){
  setLang(LANGS[(LANGS.indexOf(state.uiLang)+1)%LANGS.length]);
};
export function applyTheme(){
  // Controller theme duy nhất nằm ở window.__elabTheme (định nghĩa trong <head>).
  // Bản cũ đọc qua store.get (JSON.parse) nên không đọc được chuỗi thường -> reset nhầm.
  if(window.__elabTheme) window.__elabTheme.apply(window.__elabTheme.get());
}
export function applyUIMode(hooks={}){
  document.body.classList.toggle("kid-mode", state.uiMode==="kid");
  $("mascot").style.display = state.uiMode==="kid" ? "" : "none";
  document.querySelector("header h1").innerHTML = '<svg class="ic ic-h"><use href="#i-camera"/></svg> '+esc(t("appName"));

  $("menuTitleLbl").textContent = t("explore");
  $("menuRead").textContent = t("read");
  $("menuAudio").textContent = t("audio");
  $("menuBooks").textContent = t("books");
  $("menuProgress").textContent = t("progress");
  if($("tbScan")) $("tbScan").textContent = t("scan");
  if($("tbRead")) $("tbRead").textContent = t("read");
  if($("tbAudio")) $("tbAudio").textContent = t("audio");
  if($("tbBooks")) $("tbBooks").textContent = t("books");
  if($("tbProgress")) $("tbProgress").textContent = t("progress");
  $("audioLibTitle").textContent = t("audioLibTitle");
  if($("bookTitleGo")) $("bookTitleGo").textContent = t("uploadBtn");
  if($("bookTitleInput")) $("bookTitleInput").placeholder = t("bookTitlePh");

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
  const _upt = $("userProfileTitle"); if(_upt) _upt.textContent = t("userProfileTitle");
  $("pathTitle").textContent = t("pathTitle");
  $("bankTitle").textContent = t("bankTitle");
  $("unlockTitle").textContent = t("unlockTitle");
  $("unlockHint").textContent = t("unlockHint");
  (hooks.renderStats||(()=>{}))(); (hooks.renderBank||(()=>{}))(); (hooks.renderPath||(()=>{}))();
}
