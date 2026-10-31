import sys
from playwright.sync_api import sync_playwright
OUT=sys.argv[1]; PORT=sys.argv[2] if len(sys.argv)>2 else '8768'
U='/mnt/user-data/uploads/'
# (時間帯, 時刻, 画像, 四隅, 画像サイズ, 張り手, 施工箇所)
ROWS=[('AM','2026-10-30T08:42:00+09:00',U+'20261029_062512982_iOS.jpg',[(72,65),(405,75),(430,965),(95,970)],(475,1063),'A班','南面 3F 5-6通り'),
      ('AM','2026-10-30T10:15:00+09:00',U+'20261029_062518041_iOS.jpg',[(150,70),(535,60),(525,780),(85,770)],(633,860),'B班','南面 3F 7-8通り'),
      ('PM','2026-10-30T14:05:00+09:00',U+'20261029_062531825_iOS.jpg',[(92,45),(277,38),(278,605),(100,610)],(381,709),'A班','東面 4F 2-3通り')]
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':390,'height':2400},accept_downloads=True,timezone_id='Asia/Tokyo',locale='ja-JP'); pg=ctx.new_page()
    pg.clock.install(time='2026-10-30T08:00:00+09:00')
    pg.goto(f'http://localhost:{PORT}/index.html'); pg.wait_for_selector('#app:not([hidden])')
    pg.click('#tabs button[data-tab=settings]')
    pg.fill('#sCompany','（サンプル）○○建設 △△工事所'); pg.fill('#sSite','京王多摩川開発 B棟 外装タイル工事'); pg.fill('#sFootNote','（本資料はサンプルです）')
    pg.click('#sSave'); pg.click('#tabs button[data-tab=measure]')
    for sess,t,path,corners,(iw,ih),crew,loc in ROWS:
        pg.clock.set_fixed_time(t)
        pg.select_option('#fSession',sess); pg.fill('#fCrew',crew); pg.fill('#fLocation',loc); pg.fill('#fTile','45二丁'); pg.fill('#fLot','SAMPLE-001'); pg.fill('#fMeasurer','岩田')
        pg.set_input_files('#fFile2',path); pg.wait_for_selector('#pickerWrap:not([hidden])'); pg.wait_for_timeout(300)
        box=pg.locator('#picker').bounding_box()
        for x,y in corners: pg.mouse.click(box['x']+x*box['width']/iw, box['y']+y*box['height']/ih)
        pg.click('#runBtn'); pg.wait_for_selector('#resultPanel:not([hidden])'); pg.wait_for_timeout(300)
        print(sess, pg.inner_text('#resBadge').replace('\n',' '))
        pg.click('#saveBtn'); pg.wait_for_selector('#pickerWrap[hidden]',state='attached'); pg.wait_for_timeout(400)
    pg.click('#tabs button[data-tab=report]'); pg.wait_for_selector('tr[data-id]'); pg.wait_for_timeout(1000)
    pg.set_viewport_size({'width':1123,'height':794})
    pg.pdf(path=f'{OUT}/QCAT_日報サンプル_新様式.pdf',prefer_css_page_size=True,print_background=True)
    pg.set_viewport_size({'width':390,'height':844}); pg.wait_for_timeout(300)
    pg.screenshot(path=f'{OUT}/ui_report_mobile.png',full_page=False)
    pg.locator('summary').click()
    with pg.expect_download() as d: pg.click('#xBtn')
    d.value.save_as(f'{OUT}/QCAT_検査記録_サンプル.xlsx')
    b.close()
print('done')
