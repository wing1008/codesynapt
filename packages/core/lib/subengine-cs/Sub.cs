using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using System;
using System.IO;
using System.Linq;
using System.Text;

// C# sub-engine helper: Roslyn parse + semantic model -> resolve each invocation
// / object-creation to its declaring method/ctor (intra-project). JSON per line.
class Sub {
  static void Main(string[] args) {
    var root = Path.GetFullPath(args[0]).Replace('\\', '/').TrimEnd('/');
    var files = Directory.EnumerateFiles(args[0], "*.cs", SearchOption.AllDirectories)
      .Where(f => { var n = f.Replace('\\', '/'); return !n.Contains("/obj/") && !n.Contains("/bin/") && !n.Contains("node_modules"); })
      .ToList();
    var trees = files.Select(f => CSharpSyntaxTree.ParseText(File.ReadAllText(f), path: f)).ToList();
    var tpa = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? "").Split(Path.PathSeparator);
    var refs = tpa.Where(p => p.EndsWith(".dll") && File.Exists(p))
                  .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
    var comp = CSharpCompilation.Create("a", trees, refs,
      new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
    var sb = new StringBuilder();
    foreach (var tree in trees) {
      var model = comp.GetSemanticModel(tree);
      var callerFile = Rel(tree.FilePath.Replace('\\', '/'), root);
      if (callerFile == null) continue;
      foreach (var node in tree.GetRoot().DescendantNodes()) {
        ISymbol sym = null; int callLine = 0;
        if (node is InvocationExpressionSyntax inv) { sym = model.GetSymbolInfo(inv).Symbol; callLine = Ln(inv); }
        else if (node is ObjectCreationExpressionSyntax oc) { sym = model.GetSymbolInfo(oc).Symbol; callLine = Ln(oc); }
        else continue;
        if (sym is IMethodSymbol m) {
          var loc = m.Locations.FirstOrDefault(l => l.IsInSource);
          if (loc == null || loc.SourceTree == null) continue;
          var declFile = Rel(loc.SourceTree.FilePath.Replace('\\', '/'), root);
          if (declFile == null) continue;
          var declName = m.MethodKind == MethodKind.Constructor ? m.ContainingType.Name : m.Name;
          var declLine = loc.GetLineSpan().StartLinePosition.Line + 1;
          sb.Append("{\"callerFile\":").Append(Q(callerFile)).Append(",\"callLine\":").Append(callLine)
            .Append(",\"declName\":").Append(Q(declName)).Append(",\"declFile\":").Append(Q(declFile))
            .Append(",\"declLine\":").Append(declLine).Append("}\n");
        }
      }
    }
    Console.Out.Write(sb.ToString());
  }
  static int Ln(SyntaxNode n) => n.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
  static string Rel(string abs, string root) => abs.StartsWith(root + "/") ? abs.Substring(root.Length + 1) : null;
  static string Q(string s) { var b = new StringBuilder("\""); foreach (var c in s) { if (c == '"' || c == '\\') b.Append('\\'); b.Append(c); } return b.Append('"').ToString(); }
}
