from pathlib import Path

worker = Path('worker.js')
replacement = Path('handleui_replacement.js').read_text()
marker = "// --- [第四部分: 开发者驾驶舱 UI] ---"
text = worker.read_text()
start = text.index(marker)
new_text = text[:start] + marker + "\n" + replacement
worker.write_text(new_text)
