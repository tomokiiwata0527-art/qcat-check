import sys
from playwright.sync_api import sync_playwright
OUT=sys.argv[1]; PORT=sys.argv[2] if len(sys.argv)>2 else '8768'
U='/mnt/user-data/uploads/'
A='/mnt/user-data/attachments/4e5bdbe6-4b76-52f9-bdec-9e90a80fba07/ec9499a5-image.jpg'
errs=[]; ok=True
def check(name,cond):
    global ok; ok&=bool(cond); print(('PASS ' if cond else 'FAIL ')+name)
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':390,'height':2400},accept_downloads=True,timezone_id='Asia/Tokyo'); pg=ctx.new_page()
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None); pg.on('pageerror',lambda e: errs.append('PAGEERROR '+str(e)))
    pg.goto(f'http://localhost:{PORT}/index.html'); pg.wait_for_selector('#app:not([hidden])')
    def measure(path,corners,size,crew,loc):
        pg.fill('#fCrew',crew); pg.fill('#fLocation',loc); pg.fill('#fTile','45二丁'); pg.fill('#fMeasurer','岩田')
        pg.set_input_files('#fFile2',path); pg.wait_for_selector('#pickerWrap:not([hidden])'); pg.wait_for_timeout(300)
        box=pg.locator('#picker').bounding_box()
        for x,y in corners: pg.mouse.click(box['x']+x*box['width']/size[0], box['y']+y*box['height']/size[1])
        pg.click('#runBtn'); pg.wait_for_selector('#resultPanel:not([hidden])'); pg.wait_for_timeout(300)
    # 1件目：合格（最終判定は自動で合格が選ばれる）
    measure(U+'20261029_062512982_iOS.jpg',[(72,65),(405,75),(430,965),(95,970)],(475,1063),'A班','南面 3F 5-6通り')
    check('pass preselects 合格', 'on' in (pg.get_attribute('#finPass','class') or ''))
    pg.click('#saveBtn'); pg.wait_for_selector('#pickerWrap[hidden]',state='attached'); pg.wait_for_timeout(300)
    # 2件目：要確認（最終判定は未選択→選ばないと保存不可→理由なしでも不可）
    measure(A,[(74,62),(402,62),(430,965),(95,970)],(475,1063),'B班','南面 3F 7-8通り')
    check('caution has no preselection', 'on' not in (pg.get_attribute('#finPass','class') or '') and 'on' not in (pg.get_attribute('#finFail','class') or ''))
    pg.click('#saveBtn'); pg.wait_for_timeout(200); check('blocked: no final judgement', pg.is_visible('#resultPanel'))
    pg.click('#finPass'); pg.click('#saveBtn'); pg.wait_for_timeout(300); check('blocked: caution needs remarks', pg.is_visible('#resultPanel'))
    pg.fill('#fRemarks','63%。写真で赤は過大でないが基準を満たすため合格'); pg.click('#saveBtn'); pg.wait_for_selector('#pickerWrap[hidden]',state='attached'); pg.wait_for_timeout(300)
    # 日報
    pg.click('#tabs button[data-tab=report]'); pg.wait_for_selector('tr[data-id]'); pg.wait_for_timeout(700)
    txt=pg.inner_text('#paper')
    check('2 rows', pg.locator('tr[data-id]').count()==2)
    check('header: counts', '午前 1件 / 午後 1件' in txt or '午前 2件 / 午後 0件' in txt or '午前 0件 / 午後 2件' in txt)
    check('overall 全件合格', '全件合格' in txt)
    check('remarks shown', '写真で赤は過大でない' in txt)
    check('caution auto + 合格 final', '要確認' in txt and txt.count('合格')>=3)
    imgs=pg.eval_on_selector_all('#paper img','els=>els.map(e=>e.naturalWidth)'); check('4 images loaded '+str(imgs), len(imgs)==4 and all(w>50 for w in imgs))
    # 無効化（管理者）
    pg.locator('#rowActions button[data-id]').first.click(); pg.click('#dlgOk'); check('reason required', pg.inner_text('#dlgErr')!='')
    pg.fill('#dlgText','影が入ったため再測定'); pg.click('#dlgOk'); pg.wait_for_timeout(800)
    check('1 valid row after invalidate', pg.locator('tr[data-id]').count()==1)
    check('footnote mentions invalid', '無効（再測定）1件' in pg.inner_text('#paper'))
    # Excel
    pg.locator('summary').click()
    with pg.expect_download() as d: pg.click('#xBtn')
    d.value.save_as(f'{OUT}/e2e_export.xlsx'); check('xlsx downloaded', d.value.suggested_filename.endswith('.xlsx'))
    pg.reload(); pg.wait_for_selector('#app:not([hidden])'); pg.click('#tabs button[data-tab=report]'); pg.wait_for_selector('tr[data-id]')
    check('persisted after reload', pg.locator('tr[data-id]').count()==1)
    check('no JS errors '+str(errs), not errs)
    b.close()
print('ALL PASS' if ok else 'SOME FAILED'); sys.exit(0 if ok else 1)
