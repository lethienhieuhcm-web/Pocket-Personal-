// Bookmarklet: Tự bấm qua cảnh báo "Google hasn't verified this app"
// Cách dùng: tạo bookmark mới, paste code này vào URL, bấm khi đang ở trang cảnh báo Google

javascript:(function(){
  const t = document.body.innerText;
  // Trang 1: tìm nút "Advanced" / "Nâng cao"
  let adv = [...document.querySelectorAll('button, a')].find(e => 
    /advanced|nâng cao/i.test(e.innerText) && e.offsetParent !== null
  );
  if(adv){ adv.click(); 
    setTimeout(()=>{
      // Trang 2: tìm link "Go to ... (unsafe)" / "Tiếp tục"
      let go = [...document.querySelectorAll('button, a')].find(e => 
        /go to .*unsafe|tiếp tục/i.test(e.innerText) && e.offsetParent !== null
      );
      if(go) go.click();
      else alert('Không tìm thấy nút "Go to (unsafe)"');
    }, 800);
  } else {
    alert('Không tìm thấy nút Advanced');
  }
})();
