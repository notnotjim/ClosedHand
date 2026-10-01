# The window the downloaded DMG opens to, laid out by dmgbuild (see dmg.sh):
# the app on the left, an Applications shortcut on the right, over
# background.png (drawn from background.html at 1x and 2x). Finder writes the
# icon labels in black over a picture, so the background stays light.
import os
app = defines['app']
files = [app]
symlinks = {'Applications': '/Applications'}
background = defines['background']
format = 'UDZO'
window_rect = ((200, 120), (640, 400))
icon_size = 96
text_size = 13
icon_locations = {os.path.basename(app): (170, 230), 'Applications': (470, 230)}
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
