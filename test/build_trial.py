# 配布版のソースから、1ファイルの試用版HTML（Artifact用）を作る
import re, sys
root='/home/claude/qcat-app/'; out=sys.argv[1]
css=open(root+'style.css').read()
html=open(root+'index.html').read()
body=re.search(r'<body>(.*)</body>',html,re.S).group(1)
body=re.sub(r'<script type="module" src="js/app.js"></script>','',body)
def mod(path):
    s=open(root+path).read()
    s=re.sub(r'(?m)^import .* from .*;\s*$','',s)
    s=re.sub(r'(?m)^export ','',s)
    return s
js="const firebaseConfig={apiKey:''};\n"+mod('js/analysis.js')+"\n"+mod('js/store.js')+"\n"+mod('js/app.js')
page=f'''<title>Q-CAT 充填率チェック</title>
<style>{css}</style>
{body}
<script>window.QCAT_TRIAL=true;</script>
<script type="module">{js}</script>
'''
open(out,'w').write(page); print(len(page)//1024,'KB')
