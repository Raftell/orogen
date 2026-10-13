// Build rules of the OrogenBridge editor module (export-unreal.md 8.3). Never compiled: see README.md.

using UnrealBuildTool;

public class OrogenBridge : ModuleRules
{
	public OrogenBridge(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		// Landscape is public because the one public header returns ALandscape*.
		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
			"Landscape",
		});

		PrivateDependencyModuleNames.AddRange(new string[]
		{
			"UnrealEd",
			"AssetTools",
			"AssetRegistry",
			"Json",
			"JsonUtilities",
		});
	}
}
