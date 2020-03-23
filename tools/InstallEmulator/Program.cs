using System.Diagnostics;

namespace InstallEmulator
{
    class Program
    {
        static void Main(string[] args)
        {
            Process installerProcess = new Process();
            ProcessStartInfo processInfo = new ProcessStartInfo();
            processInfo.Arguments = @"/i  azure-cosmosdb-emulator-2.9.2-ae070d26.msi  /q";
            processInfo.FileName = "msiexec";
            installerProcess.StartInfo = processInfo;
            installerProcess.Start();
            installerProcess.WaitForExit();
        }
    }
}
