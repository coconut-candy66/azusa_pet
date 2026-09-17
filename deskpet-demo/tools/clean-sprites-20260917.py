"""Non-generative alpha cleanup from the immutable 20260917 sprite backup.

Run without flags to prepare/review; --install copies reviewed PNGs and masks.
RGB and canvas dimensions are preserved exactly, including at the edited skirt.
"""
from pathlib import Path
import argparse
import importlib.util
import json
import shutil
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parents[2]
BACKUP = ROOT / 'art/backups/2026-09-17-before-cutout/sprites'
OUT = ROOT / 'art/reports/2026-09-17-cutout'
STAGED = OUT / 'cleaned'


def polygon_mask(size, points):
    scale = 8
    mask = Image.new('L', (size[0]*scale, size[1]*scale), 0)
    ImageDraw.Draw(mask).polygon([(round(x*scale), round(y*scale)) for x,y in points], fill=255)
    return np.asarray(mask.resize(size, Image.Resampling.LANCZOS))


def clean(path):
    original = np.array(Image.open(path).convert('RGBA'))
    result = original.copy()
    rgb = original[:,:,:3].astype(float)
    alpha = original[:,:,3].copy()
    r,g,b = rgb[:,:,0],rgb[:,:,1],rgb[:,:,2]
    span = b-r
    ratio = (g-r) / np.maximum(span, 1)
    # The unwanted matte is steel blue (~42,79,117); navy garments have a
    # substantially more violet hue. Do not globally key white or dark colors.
    blue = (r<115)&(g<150)&(b<190)&(span>20)&(span>0.60*b)&(g-r>5)&(ratio>.24)&(ratio<.78)
    protect = np.zeros(alpha.shape, bool)
    outfit = path.parent.name[:3]
    if outfit == 'zh2':
        clothes = {
          'idle':[(253,349),(287,349),(333,369),(379,435),(369,450),(354,449),(350,482),(378,553),(359,576),(206,589),(168,553),(201,487),(211,449),(180,432),(223,368)],
          'happy':[(234,362),(324,355),(354,368),(395,428),(370,449),(370,487),(405,556),(384,575),(236,600),(176,556),(214,487),(227,438),(186,446),(179,420),(190,369)],
          'surprise':[(260,381),(303,381),(343,396),(383,466),(369,479),(351,481),(352,517),(387,594),(340,623),(214,627),(162,586),(207,515),(219,468),(174,466),(217,401)]
        }
        protect = polygon_mask((alpha.shape[1],alpha.shape[0]),clothes[path.stem])>0
    elif outfit == 'zh5':
        protect[425:525,130:330] = True  # cyan denim and its original dark seams
    elif outfit == 'zh1':
        protect[360:625,140:420] = True  # dark school blazer / skirt
        protect[620:699,185:355] = True  # navy socks
    elif outfit == 'zh3':
        protect[365:630,212:362] = True  # apron and central dark dress
    # Individually inspected pockets contain darker versions of the same matte.
    # These polygons stay in the gaps between the actual hair and clothing.
    pockets = {
      ('zh2','surprise'):[[(119,370),(153,365),(176,402),(166,439),(115,455)],
                         [(354,390),(404,389),(427,418),(426,548),(364,556),(363,479)]],
      ('zh3','happy'):[[(143,349),(181,333),(220,371),(214,489),(149,485)],
                     [(360,405),(430,401),(430,509),(373,501)]],
      ('zh5','surprise'):[[(306,316),(350,317),(354,423),(318,458),(298,418)],
                          [(142,360),(172,355),(182,451),(139,458)]],
    }
    local = np.zeros(alpha.shape,bool)
    for poly in pockets.get((outfit,path.stem),[]):
        local |= polygon_mask((alpha.shape[1],alpha.shape[0]),poly)>127
    blue |= local & (r<100)&(g<125)&(b<170)&(span>15)&(span>0.34*b)&(g-r>3)&(ratio>.22)
    blue &= ~protect
    remove = blue & (alpha>0)
    # Recover the dim, antialiased blue contamination adjoining the same matte.
    weak = (r<100)&(b<175)&(span>5)&(span>0.48*b)&(g-r>1)&(ratio>.23)&(ratio<.80)
    remove |= ndi.binary_dilation(remove, iterations=1) & weak & ~protect
    alpha[remove] = 0
    alpha[alpha<12] = 0

    # Remove only the erroneous extra lower arm beside the idle sailor skirt.
    # The slanted boundary follows the OUTSIDE of the original skirt outline;
    # the true upper arm, skirt colors and black contour remain untouched.
    if path.parent.name.startswith('zh2_') and path.stem == 'idle':
        m = polygon_mask((alpha.shape[1],alpha.shape[0]), [
            (351.5,500.5),(354.5,505),(358,513),(362,522),(366,533),
            (371,545),(374,550),(374,556),(370,561),
            (388,571),(412,571),(411,495),(373,495),(364,501)
        ])
        alpha = np.minimum(alpha, 255-m)
        # The narrow vertical matte remnant beside the right cheek is outside
        # both the actual bangs and the right twin tail.
        m = polygon_mask((alpha.shape[1],alpha.shape[0]),[
            (399,352),(415,352),(415,426),(393,426),(392,385),(393,369)
        ])
        alpha = np.minimum(alpha,255-m)

    # Keep the contiguous character and the sailor surprise frame's real hand
    # (which was previously attached only by an erroneous blue background blob).
    labels, count = ndi.label(alpha>64, structure=np.ones((3,3)))
    sizes = np.bincount(labels.ravel())
    valid = np.zeros(len(sizes),bool)
    valid[1+np.argmax(sizes[1:])] = True
    if outfit == 'zh2' and path.stem == 'surprise':
        valid[labels[530,384]] = True
        valid[0] = False
    solid = valid[labels]
    near_solid = ndi.binary_dilation(solid, iterations=1)
    alpha[~near_solid] = 0
    # Subpixel edge antialiasing only; interior opacity and all RGB stay exact.
    # A very small close seals single-pixel notches in the cutout boundary.
    core = alpha>=128
    closed = ndi.binary_closing(core,structure=np.ones((3,3)))
    restore = closed & ~core & (original[:,:,3]>=240)
    alpha[restore] = original[:,:,3][restore]
    soft = ndi.gaussian_filter((alpha/255.).astype(np.float32),sigma=.42)
    edge = ndi.maximum_filter(alpha,3)!=ndi.minimum_filter(alpha,3)
    alpha[edge] = np.minimum(original[:,:,3][edge],np.round(soft[edge]*255).astype(np.uint8))
    result[:,:,3] = alpha
    assert np.array_equal(result[:,:,:3], original[:,:,:3])
    return result, {'outfit':path.parent.name,'frame':path.stem,
                    'changed_alpha_pixels':int(np.count_nonzero(alpha!=original[:,:,3])),
                    'removed_opaque_pixels':int(np.count_nonzero((alpha==0)&(original[:,:,3]>=128))),
                    'rgb_changed_pixels':0,'size':[result.shape[1],result.shape[0]]}


def contact(paths, destination, background):
    canvas = Image.new('RGB',(1500,1260),background)
    draw = ImageDraw.Draw(canvas)
    for col,folder in enumerate(sorted(set(p.parent for p in paths))):
        for row,frame in enumerate(['idle','happy','surprise']):
            im=Image.open(folder/(frame+'.png'))
            im.thumbnail((280,390),Image.Resampling.LANCZOS)
            x=col*300+(300-im.width)//2
            y=row*420+24
            canvas.paste(im,(x,y),im.getchannel('A'))
            draw.text((col*300+8,row*420+5),f'{col+1} {frame}',fill='#808080')
    canvas.save(destination)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--install',action='store_true')
    args=parser.parse_args()
    STAGED.mkdir(parents=True,exist_ok=True)
    records=[]
    for source in sorted(BACKUP.glob('*/*.png')):
        result,record=clean(source)
        dest=STAGED/source.parent.name/source.name
        dest.parent.mkdir(exist_ok=True)
        Image.fromarray(result,'RGBA').save(dest)
        records.append(record)
    spec=importlib.util.spec_from_file_location('sprite_tools',Path(__file__).with_name('make-sprite.py'))
    mod=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for folder in sorted(STAGED.iterdir()):
        old=json.loads((BACKUP/folder.name/'mask.json').read_text(encoding='utf-8'))
        mod.bake_mask(str(folder/'idle.png'),str(folder/'mask.json'),old['h'])
        ok,detail=mod.verify_mask(str(folder/'mask.json'),str(folder/'idle.png'),old['h'])
        assert ok,detail
    contact(list(STAGED.glob('*/*.png')),OUT/'after-light.png','#e8e8e8')
    contact(list(STAGED.glob('*/*.png')),OUT/'after-dark.png','#292b30')
    (OUT/'verification.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
    if args.install:
        for folder in sorted(STAGED.iterdir()):
            runtime=ROOT/'deskpet-demo/assets/sprites'/folder.name
            archive=ROOT/'art/final'/folder.name.replace('zh','yq',1)
            assert runtime.is_dir() and archive.is_dir()
            for p in folder.iterdir():
                shutil.copy2(p,runtime/p.name)
                shutil.copy2(p,archive/p.name)
    print(json.dumps(records,ensure_ascii=False,indent=2))
    print('INSTALLED' if args.install else 'STAGED FOR REVIEW')


if __name__=='__main__':
    main()
