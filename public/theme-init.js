/**
 * 主题初始化：在首屏绘制前同步读取偏好，避免闪一下浅色。
 * 偏好存 localStorage（扩展页面同源，读取是同步的）。
 * auto 时跟随系统，并监听系统切换。
 */
(function () {
  var KEY = 'page2md-theme';
  var VALID = { auto: 1, light: 1, dark: 1 };
  var pref = 'auto';
  try {
    pref = localStorage.getItem(KEY) || 'auto';
  } catch (error) {
    pref = 'auto';
  }
  if (!VALID[pref]) pref = 'auto';

  var mq = window.matchMedia('(prefers-color-scheme: dark)');

  function apply() {
    var dark = pref === 'dark' || (pref === 'auto' && mq.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.themePref = pref;
  }

  apply();

  mq.addEventListener('change', function () {
    if (pref === 'auto') apply();
  });

  window.__setPage2mdTheme = function (next) {
    if (!VALID[next]) return;
    pref = next;
    try {
      localStorage.setItem(KEY, next);
    } catch (error) {
      /* 隐私模式等情况忽略 */
    }
    apply();
  };
})();
