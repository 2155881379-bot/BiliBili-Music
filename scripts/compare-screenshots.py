"""Read-only pixel comparison of saved Electron UI screenshots (Pillow)."""
import json
from pathlib import Path
from PIL import Image, ImageChops, ImageStat

directory = Path(__file__).resolve().parents[1] / 'output/playwright/performance'
results = {}
for current in directory.glob('optimized-final-*.png'):
    name = current.stem.removeprefix('optimized-final-')
    original = Image.open(directory / f'baseline-ui-{name}.png').convert('RGB')
    updated = Image.open(current).convert('RGB')
    difference = ImageChops.difference(original, updated)
    stats = ImageStat.Stat(difference)
    results[name] = {
        'size': original.size,
        'meanChannelDifference': sum(stats.mean) / 3,
        'changedAbove12Percent': sum(1 for pixel in difference.getdata() if max(pixel) > 12) / (original.width * original.height) * 100
    }
(directory / 'visual-comparison.json').write_text(json.dumps(results, indent=2), encoding='utf8')
print(json.dumps(results, indent=2))
