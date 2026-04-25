(function () {
  var style = document.createElement('style');
  style.textContent = [
    '#tomu-global-header {',
    '  position: fixed;',
    '  top: 0;',
    '  left: 0;',
    '  right: 0;',
    '  height: calc(44px + env(safe-area-inset-top));',
    '  padding-top: env(safe-area-inset-top);',
    '  background: rgba(0,0,0,0.8);',
    '  display: flex;',
    '  align-items: center;',
    '  padding-left: 16px;',
    '  z-index: 9999;',
    '  box-sizing: border-box;',
    '}',
    '#tomu-global-header a {',
    '  color: #d4af37;',
    '  text-decoration: none;',
    '  font-size: 15px;',
    '  font-weight: bold;',
    '  font-family: sans-serif;',
    '  letter-spacing: 0.03em;',
    '}',
    '#tomu-global-header a:hover {',
    '  opacity: 0.8;',
    '}',
  ].join('\n');
  document.head.appendChild(style);

  var header = document.createElement('div');
  header.id = 'tomu-global-header';
  header.innerHTML = '<a href="https://tomu-ai963.github.io/tomu-system/">&#8592; とむSYSTEM</a>';

  var bodyStyle = document.createElement('style');
  bodyStyle.textContent = 'body { padding-top: calc(44px + env(safe-area-inset-top)) !important; }';
  document.head.appendChild(bodyStyle);

  if (document.body) {
    document.body.insertBefore(header, document.body.firstChild);
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      document.body.insertBefore(header, document.body.firstChild);
    });
  }
})();
