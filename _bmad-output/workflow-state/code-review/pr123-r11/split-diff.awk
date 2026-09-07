# Usage: awk -v cap=N -v prefix=OUT this-file diffinput
# Splits unified diff into parts of <=cap lines at hunk boundaries.
BEGIN { part=1; out=sprintf("%s-%02d.diff", prefix, part); size=0; pre=0; inpre=1 }
/^@@ / { inpre=0 }
{
  if (inpre) { preamble[++pre]=$0; next }
  if ($0 ~ /^@@ /) { hunk=1 }
  if (size+hunk > cap && size > 0) {
    part++; out=sprintf("%s-%02d.diff", prefix, part); size=0
    for(i=1;i<=pre;i++) print preamble[i] > out
    size=pre
  }
  print $0 > out; size+=1; hunk=0
}
END { printf("%d parts\n", part) > "/dev/stderr" }
