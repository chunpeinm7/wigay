import os
files = [
    r'C:\Users\Austin\Desktop\wigay-main\wi-care-web\gesture-lab\data\clap.json',
    r'C:\Users\Austin\Desktop\wigay-main\wi-care-web\gesture-lab\data\empty_room.json',
    r'C:\Users\Austin\Desktop\wigay-main\wi-care-web\gesture-lab\data\squat.json',
    r'C:\Users\Austin\Desktop\wigay-main\wi-care-web\gesture-lab\data\wave.json',
]
for f in files:
    with open(f, 'r', encoding='utf-8') as fh:
        content = fh.read()
    content = content.replace('"deviceA"', '"Raw Score"').replace('"deviceB"', '"Smoothed Score"')
    with open(f, 'w', encoding='utf-8') as fh:
        fh.write(content)
    print(f'Done: {os.path.basename(f)}')
