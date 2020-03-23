using System.Diagnostics;

namespace LaunchEmulator
{
    class Program
    {
        static void Main(string[] args)
        {
            Process installerProcess = new Process();
            ProcessStartInfo processInfo = new ProcessStartInfo();
            processInfo.Arguments = @"/DisableRateLimiting /EnableMongoDbEndpoint=3.6 /NoUI /NoExplorer";
            processInfo.FileName = @"C:\Program Files\Azure Cosmos DB Emulator\Microsoft.Azure.Cosmos.Emulator.exe";
            installerProcess.StartInfo = processInfo;
            installerProcess.Start();
            System.Threading.Thread.Sleep(5000);
        }
    }
}
