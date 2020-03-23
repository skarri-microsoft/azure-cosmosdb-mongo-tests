#!c:\venv\py3\mongo36r\scripts\python.exe
# EASY-INSTALL-ENTRY-SCRIPT: 'Cheetah3==3.2.4','console_scripts','cheetah'
__requires__ = 'Cheetah3==3.2.4'
import re
import sys
from pkg_resources import load_entry_point

if __name__ == '__main__':
    sys.argv[0] = re.sub(r'(-script\.pyw?|\.exe)?$', '', sys.argv[0])
    sys.exit(
        load_entry_point('Cheetah3==3.2.4', 'console_scripts', 'cheetah')()
    )
