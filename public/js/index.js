const f = document.getElementById('f');
f.onsubmit = e => { e.preventDefault(); location.href = '/speel?code=' + encodeURIComponent(document.getElementById('code').value.trim().toUpperCase()); };
