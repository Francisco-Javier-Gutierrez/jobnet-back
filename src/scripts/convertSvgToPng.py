import os
import subprocess
from PIL import Image

def render_svg_to_png(svg_path, out_png_path, width, height):
    temp_html = os.path.abspath('temp_render.html')
    svg_abs = os.path.abspath(svg_path).replace('\\', '/')
    with open(temp_html, 'w', encoding='utf-8') as f:
        f.write(f'''<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  html, body {{ background: transparent !important; margin: 0; padding: 0; overflow: hidden; }}
  img {{ display: block; width: {width}px; height: {height}px; }}
</style>
</head>
<body>
  <img src="file:///{svg_abs}" width="{width}" height="{height}" />
</body>
</html>''')
    
    edge_path = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
    raw_shot = os.path.abspath('raw_screenshot.png')
    if os.path.exists(raw_shot):
        os.remove(raw_shot)

    cmd = [
        edge_path,
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--default-background-color=00000000',
        f'--window-size={width},{height}',
        f'--screenshot={raw_shot}',
        f'file:///{temp_html.replace(chr(92), "/")}'
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    if not os.path.exists(raw_shot):
        print(f"Error: {raw_shot} was not created")
        return

    img = Image.open(raw_shot)
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    
    bbox = img.getbbox()
    print(f"File: {svg_path} -> Raw size: {img.size}, Bbox: {bbox}")
    if bbox:
        cropped = img.crop(bbox)
        # Also let's create a retina version or resize if needed
        cropped.save(out_png_path, 'PNG', optimize=True)
        print(f"Successfully saved {out_png_path} ({cropped.size})")
    else:
        img.save(out_png_path, 'PNG', optimize=True)
        print(f"Saved full {out_png_path} ({img.size})")

    if os.path.exists(temp_html):
        os.remove(temp_html)
    if os.path.exists(raw_shot):
        os.remove(raw_shot)

if __name__ == '__main__':
    render_svg_to_png('jobnet-front/public/logo.svg', 'jobnet-front/public/logo.png', 973, 877)
    render_svg_to_png('jobnet-front/public/logotipo.svg', 'jobnet-front/public/logotipo.png', 672, 581)
