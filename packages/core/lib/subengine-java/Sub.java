import com.sun.source.tree.*;
import com.sun.source.util.*;
import javax.tools.*;
import javax.lang.model.element.*;
import java.util.*;
import java.io.*;
import java.nio.file.*;

// Java sub-engine helper: uses the javac Compiler API to parse + type-attribute
// a source tree and emit, for every method-invocation / new, the resolved
// declaration (intra-project only). Output: one JSON object per line on stdout.
public class Sub {
  public static void main(String[] args) throws Exception {
    Path root = Paths.get(args[0]).toAbsolutePath().normalize();
    List<File> files = new ArrayList<>();
    try (java.util.stream.Stream<Path> s = Files.walk(root)) {
      s.filter(p -> p.toString().endsWith(".java")
           && !p.toString().contains(File.separator + "node_modules" + File.separator))
       .forEach(p -> files.add(p.toFile()));
    }
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    StandardJavaFileManager fm = compiler.getStandardFileManager(null, null, null);
    Iterable<? extends JavaFileObject> units = fm.getJavaFileObjectsFromFiles(files);
    JavacTask task = (JavacTask) compiler.getTask(
        new PrintWriter(new StringWriter()), fm, d -> {},
        Arrays.asList("-proc:none", "-encoding", "UTF-8"), null, units);
    Iterable<? extends CompilationUnitTree> asts = task.parse();
    try { task.analyze(); } catch (Throwable t) { /* best-effort attribution */ }
    final Trees trees = Trees.instance(task);
    final SourcePositions sp = trees.getSourcePositions();
    final StringBuilder out = new StringBuilder();
    final String rootStr = root.toString().replace('\\', '/');

    for (final CompilationUnitTree cu : asts) {
      final LineMap lm = cu.getLineMap();
      final String callerFile = rel(cu.getSourceFile().toUri().getPath().replace('\\', '/'), rootStr);
      if (callerFile == null) continue;
      new TreePathScanner<Void, Void>() {
        @Override public Void visitMethodInvocation(MethodInvocationTree node, Void p) { emit(node); return super.visitMethodInvocation(node, p); }
        @Override public Void visitNewClass(NewClassTree node, Void p) { emit(node); return super.visitNewClass(node, p); }
        void emit(Tree node) {
          try {
            TreePath path = new TreePath(getCurrentPath(), node);
            Element el = trees.getElement(path);
            if (el == null) return;
            if (el.getKind() != ElementKind.METHOD && el.getKind() != ElementKind.CONSTRUCTOR) return;
            TreePath declPath = trees.getPath(el);
            if (declPath == null) return; // external (no source) -> skip
            CompilationUnitTree dcu = declPath.getCompilationUnit();
            String declFile = rel(dcu.getSourceFile().toUri().getPath().replace('\\', '/'), rootStr);
            if (declFile == null) return; // outside project
            Element owner = el.getEnclosingElement();
            String declName = el.getKind() == ElementKind.CONSTRUCTOR
                ? (owner != null ? owner.getSimpleName().toString() : "<init>")
                : el.getSimpleName().toString();
            long callPos = sp.getStartPosition(cu, node);
            long callLine = callPos >= 0 ? lm.getLineNumber(callPos) : 0;
            long declPos = sp.getStartPosition(dcu, declPath.getLeaf());
            long declLine = declPos >= 0 ? dcu.getLineMap().getLineNumber(declPos) : 0;
            out.append("{\"callerFile\":").append(q(callerFile))
               .append(",\"callLine\":").append(callLine)
               .append(",\"declName\":").append(q(declName))
               .append(",\"declFile\":").append(q(declFile))
               .append(",\"declLine\":").append(declLine).append("}\n");
          } catch (Throwable t) { /* skip */ }
        }
      }.scan(cu, null);
    }
    System.out.print(out);
  }
  static String rel(String abs, String root) {
    if (abs == null) return null;
    if (abs.startsWith("/") && abs.length() > 2 && abs.charAt(2) == ':') abs = abs.substring(1); // /C:/... -> C:/...
    if (abs.startsWith(root + "/")) return abs.substring(root.length() + 1);
    return null;
  }
  static String q(String s) {
    StringBuilder b = new StringBuilder("\"");
    for (char c : s.toCharArray()) { if (c == '"' || c == '\\') b.append('\\'); b.append(c); }
    return b.append('"').toString();
  }
}
