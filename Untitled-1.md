Next new feature.

When selecting "Generate ... Snippet" or "Generate ... Template" from an XML file, we know the XML file that we are in. If this is the case and we know the XML file, we can some of the variables in the templates/snippets if an xpath to these is provided in the configuration for them.

For example, for this fragment snippet: 

        "kahua.tokenNameDefinitions": {
          "type": "array",
          "default": [
            {
              "id": "appname",
              "name": "App Name Header",
              "type": "header",
              "tokens": "appname"
            },
            {
              "id": "attributes",
              "name": "Attribute Tokens",
              "type": "table",
              "tokens": "name,type,entity:Field,visualtype:TextBox,label,descriptionlabel,linkedEntityDef"
            },
            {
              "id": "lookupheader",
              "name": "Lookup Header Tokens",
              "type": "header",
              "tokens": "entity,listname"

we know in standard Kahua XML files that the appname is defined in the Name attribute of the root "App" element like this:
<App Name="kahua_AEC_RFI" DataScope="Default" AppScope="Partition" Version="1750" VersionLabel="1.0" Description="[AppDescription]" Label="[AppLabel]" PermissionMode="RevokeByDefault" IsConfigurable="true" IsShareable="true" CultureCode="en" PlatformScript="kahua_AEC_RFI.App">

We also know that the $entity variable is defined as the name element in EntityDef elements here:
<App .... >
  <EntityDefs>
    <EntityDef Name="RFI" IsAttachable="True" IsConfigurable="True" Description="AEC Request For Information" Label="[EntityDefLabel]" LabelPlural="[EntityDefLabelPlural]" LabelAbbv="[EntityDefLabelAbbv]" LabelAbbvPlural="[EntityDefLabelAbbvPlural]" EntityType="Document" IsSearchable="True" IsReportable="True" DefaultEntityActionList="kahua_AEC_RFI.RFIDefaultEntityActions" DefaultReport="kahua_AEC_RFI.RFIViewReport" AutomationLabel="[Attribute(Number)] [Attribute(Subject)]">
      <Attributes>

We need to be able to define these to be used as defaults in cases when we have an XML file and these elements/attributes exist.
In cases where multiple options occur (such as if there are multiple entitydef elements with the Name attribute), then the user can select in the quick pick OR skip and have it be blank (as is the current behaviour).