# Usage: python3 logrow.py <readme> <row-file> [<replace-old-file> <replace-new-file>]
import sys
p, rowf = sys.argv[1], sys.argv[2]
s = open(p).read()
row = open(rowf).read().rstrip('\n') + '\n'
anchor = '\n### Owner asks raised since handoff'
i = s.index(anchor)
s = s[:i].rstrip('\n') + '\n' + row + s[i:]
if len(sys.argv) > 4:
    old, new = open(sys.argv[3]).read(), open(sys.argv[4]).read()
    assert old in s, 'replace target missing'
    s = s.replace(old, new)
open(p, 'w').write(s)
