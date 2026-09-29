# dmgbuild settings for the GAIC macOS disk image. They reproduce the GAIC
# 2.4.0 image's layout exactly (read from its .DS_Store): a 540x380 window at
# {400, 530} with no toolbar, 80 px icons with 12 pt labels, GAIC.app at
# (130, 220) and an Applications link at (410, 220), and the 2.4.0 background
# and volume icon files, in a bzip2-compressed HFS+ image.
#
#   dmgbuild -s dmg_settings.py -D app=<GAIC.app> -D background=<.background.tiff> \
#            -D icon=<.VolumeIcon.icns> "GAIC <version>" <out.dmg>
app = defines["app"]  # noqa: F821 (dmgbuild provides `defines`)
background = defines["background"]  # noqa: F821
icon = defines["icon"]  # noqa: F821

format = "UDBZ"
filesystem = "HFS+"
files = [app]
symlinks = {"Applications": "/Applications"}
icon_locations = {"GAIC.app": (130, 220), "Applications": (410, 220)}

default_view = "icon-view"
window_rect = ((400, 530), (540, 380))
icon_size = 80
text_size = 12
label_pos = "bottom"
arrange_by = None
grid_offset = (0, 0)
grid_spacing = 100
scroll_position = (0, 0)
show_icon_preview = False
show_item_info = False
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
sidebar_width = 180
